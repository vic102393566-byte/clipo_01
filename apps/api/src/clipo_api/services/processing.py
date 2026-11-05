"""O que o worker faz com cada tipo de job. Cada passo é idempotente: se o worker cair no meio,
outro retoma o job e pula o que já estava pronto (miniatura, prévia, cada parte do corte).
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.config import get_settings
from clipo_api.core.plans import get_plan
from clipo_api.observability.logs import record
from clipo_api.services import jobs, media, storage

log = logging.getLogger("clipo.worker")


class JobCancelled(Exception):
    pass


class PermanentError(Exception):
    """Erro do próprio arquivo ou pedido: tentar de novo não resolve."""


class Yield(Exception):
    """Acabou o tempo desta fatia (Vercel): o job volta para a fila e continua de onde parou."""


@dataclass
class JobContext:
    db: AsyncDatabase
    job: dict[str, Any]
    worker_id: str
    scratch: Path
    cancelled: bool = False
    process: asyncio.subprocess.Process | None = None
    # Prazo da fatia (time.monotonic). None = sem limite (worker de verdade).
    deadline: float | None = None
    _last_progress: float = field(default=0.0)

    @property
    def id(self) -> str:
        return self.job["_id"]

    @property
    def user_id(self) -> str:
        return self.job["user_id"]

    @property
    def state(self) -> dict[str, Any]:
        return self.job.setdefault("state", {})

    def attach(self, proc: asyncio.subprocess.Process) -> None:
        self.process = proc
        if self.cancelled and proc.returncode is None:
            proc.kill()

    def check(self) -> None:
        if self.cancelled:
            raise JobCancelled

    def checkpoint(self) -> None:
        """Ponto seguro entre etapas: para aqui se a fatia de tempo acabou."""
        self.check()
        if self.deadline is not None and time.monotonic() > self.deadline:
            raise Yield

    async def progress(self, percent: float, message: str, **state: Any) -> None:
        # No máximo uma escrita por segundo de andamento, para não lotar o banco.
        now = time.monotonic()
        if state or now - self._last_progress >= 1 or percent >= 100:
            self._last_progress = now
            if state:
                self.state.update(state)
            await jobs.progress(self.db, self.id, percent, message, state or None)

    def scaled(self, start: float, end: float, message: str) -> Callable[[float], Awaitable[None]]:
        async def report(fraction: float) -> None:
            await self.progress(start + (end - start) * fraction, message)

        return report


async def _download_source(ctx: JobContext, key: str) -> Path:
    if get_settings().is_serverless:
        # Na Vercel não há disco para o vídeo inteiro: o FFmpeg lê direto do armazenamento.
        return storage.internal_url(key, seconds=3600)  # type: ignore[return-value]
    dest = ctx.scratch / "source"
    if not dest.exists():
        await storage.download(key, dest)
    return dest


# ---------------------------------------------------------------- vídeo enviado


async def ingest(ctx: JobContext) -> dict[str, Any]:
    db = ctx.db
    video = await db.videos.find_one({"_id": ctx.job["payload"]["video_id"], "user_id": ctx.user_id})
    if video is None or video.get("deleted_at"):
        return {"skipped": "vídeo removido"}

    await ctx.progress(5, "Baixando o vídeo para processar")
    src = await _download_source(ctx, video["source_key"])
    ctx.check()

    if video.get("duration_s") is None:
        await ctx.progress(15, "Conferindo o vídeo")
        try:
            info = await media.probe(src)
        except media.MediaError as exc:
            await _reject(ctx, video, f"Arquivo de vídeo inválido: {exc}")
            raise PermanentError(str(exc)) from exc
        user = await db.users.find_one({"_id": ctx.user_id}, projection={"plan_id": 1})
        plan = await get_plan(db, (user or {}).get("plan_id"))
        if info.duration > plan.max_duration_seconds:
            message = (
                f"O vídeo tem {media.format_duration(info.duration)}; o plano {plan.name} aceita até "
                f"{plan.max_duration_seconds // 60} minutos."
            )
            await _reject(ctx, video, message)
            raise PermanentError(message)
        video.update(duration_s=info.duration, width=info.width, height=info.height, has_audio=info.has_audio)
        await db.videos.update_one(
            {"_id": video["_id"]},
            {
                "$set": {k: video[k] for k in ("duration_s", "width", "height", "has_audio")}
                | {"status": "processing"}
            },
        )

    if not video.get("thumb_key"):
        await ctx.progress(25, "Gerando a miniatura")
        thumb = ctx.scratch / "thumb.jpg"
        if await media.thumbnail(src, thumb, min(1.0, video["duration_s"] / 2)):
            key = f"{storage.user_prefix(ctx.user_id)}videos/{video['_id']}/thumb.jpg"
            await storage.upload(thumb, key, "image/jpeg")
            await db.videos.update_one(
                {"_id": video["_id"]}, {"$set": {"thumb_key": key, "thumb_size": thumb.stat().st_size}}
            )
    ctx.check()

    if not video.get("preview_key") and not get_settings().is_serverless:
        # Na Vercel a prévia (versão leve) fica de fora: o editor toca o original.
        out = ctx.scratch / "preview.mp4"
        await media.preview(
            src,
            out,
            video["duration_s"],
            on_start=ctx.attach,
            on_progress=ctx.scaled(30, 95, "Preparando a prévia"),
        )
        ctx.check()
        key = f"{storage.user_prefix(ctx.user_id)}videos/{video['_id']}/preview.mp4"
        await storage.upload(out, key, "video/mp4")
        await db.videos.update_one(
            {"_id": video["_id"]}, {"$set": {"preview_key": key, "preview_size": out.stat().st_size}}
        )

    await db.videos.update_one(
        {"_id": video["_id"]}, {"$set": {"status": "ready", "ready_at": datetime.now(UTC), "error": None}}
    )
    await record(
        "video",
        "ingest.done",
        f"Vídeo pronto: {video['title']}",
        outcome="success",
        user_id=ctx.user_id,
        details={"video_id": video["_id"], "duration_s": round(video["duration_s"], 1)},
    )
    return {"video_id": video["_id"]}


async def _reject(ctx: JobContext, video: dict[str, Any], message: str) -> None:
    """Arquivo que não serve (não é vídeo, longo demais): o original é apagado e não ocupa cota."""
    with contextlib.suppress(Exception):
        await storage.delete_object(video["source_key"])
    await ctx.db.videos.update_one(
        {"_id": video["_id"]}, {"$set": {"status": "rejected", "error": message, "source_size": 0}}
    )
    await record(
        "video",
        "ingest.rejected",
        message,
        level="warning",
        outcome="failure",
        user_id=ctx.user_id,
        details={"video_id": video["_id"]},
    )


# ---------------------------------------------------------------- cortes


def plan_segments(duration: float, segment_seconds: int) -> list[tuple[float, float]]:
    """Partes de `segment_seconds`; uma sobra de menos de 1 s entra na parte anterior."""
    segments: list[tuple[float, float]] = []
    start = 0.0
    while start < duration - 1:
        end = min(duration, start + segment_seconds)
        if duration - end < 1:
            end = duration
        segments.append((start, end))
        start = end
    return segments or [(0.0, duration)]


async def _render(ctx: JobContext, src: Path, clip: dict[str, Any], start_pct: float, end_pct: float) -> None:
    out = ctx.scratch / f"{clip['_id']}.mp4"
    length = clip["end_s"] - clip["start_s"]
    await ctx.db.clips.update_one({"_id": clip["_id"]}, {"$set": {"status": "rendering"}})
    from clipo_api.services.settings import workspace as workspace_settings

    export = (await workspace_settings(ctx.db, ctx.user_id))["render"]["export"]
    await media.cut(
        src,
        out,
        clip["start_s"],
        length,
        on_start=ctx.attach,
        on_progress=ctx.scaled(start_pct, end_pct, f"Renderizando: {clip['title']}"),
        export=export,
    )
    ctx.check()
    info = await media.probe(out)
    base = f"{storage.user_prefix(ctx.user_id)}clips/{clip['_id']}"
    await storage.upload(out, f"{base}.mp4", "video/mp4")
    fields: dict[str, Any] = {
        "status": "ready",
        "key": f"{base}.mp4",
        "size": out.stat().st_size,
        "duration_s": info.duration,
        "ready_at": datetime.now(UTC),
        "error": None,
    }
    thumb = ctx.scratch / f"{clip['_id']}.jpg"
    if await media.thumbnail(out, thumb, min(1.0, info.duration / 2)):
        await storage.upload(thumb, f"{base}.jpg", "image/jpeg")
        fields.update(thumb_key=f"{base}.jpg", thumb_size=thumb.stat().st_size)
    await ctx.db.clips.update_one({"_id": clip["_id"]}, {"$set": fields})
    out.unlink(missing_ok=True)


async def split(ctx: JobContext) -> dict[str, Any]:
    db = ctx.db
    payload = ctx.job["payload"]
    video = await db.videos.find_one({"_id": payload["video_id"], "user_id": ctx.user_id})
    if video is None or video.get("deleted_at"):
        raise PermanentError("O vídeo foi removido.")
    if video["status"] != "ready":
        raise PermanentError("O vídeo ainda está sendo processado.")

    if not ctx.state.get("planned"):
        segments = plan_segments(video["duration_s"], payload["segment_seconds"])
        now = datetime.now(UTC)
        for index, (start, end) in enumerate(segments, 1):
            # Id fixo por job e parte: rodar de novo não duplica cortes.
            await db.clips.update_one(
                {"_id": f"{ctx.id}-{index}"},
                {
                    "$setOnInsert": {
                        "user_id": ctx.user_id,
                        "video_id": video["_id"],
                        "job_id": ctx.id,
                        "index": index,
                        "title": f"{video['title']} - Parte {index}",
                        "description": "",
                        "tags": [],
                        "start_s": start,
                        "end_s": end,
                        "status": "queued",
                        "created_at": now,
                        "schema_version": 1,
                    }
                },
                upsert=True,
            )
        await ctx.progress(3, f"{len(segments)} partes planejadas", planned=True, total=len(segments))

    clips = await db.clips.find({"job_id": ctx.id}).sort("index", 1).to_list()
    total = len(clips)
    src = await _download_source(ctx, video["source_key"])
    for clip in clips:
        ctx.checkpoint()
        if clip["status"] == "ready":
            continue  # já feito antes de o worker cair
        start_pct = 5 + 90 * (clip["index"] - 1) / total
        await _render(ctx, src, clip, start_pct, 5 + 90 * clip["index"] / total)
    await record(
        "job",
        "split.done",
        f"Corte concluído: {total} parte(s)",
        outcome="success",
        user_id=ctx.user_id,
        details={"job_id": ctx.id, "video_id": video["_id"], "parts": total},
    )
    return {"video_id": video["_id"], "clips": total}


async def render_clip(ctx: JobContext) -> dict[str, Any]:
    clip = await ctx.db.clips.find_one({"_id": ctx.job["payload"]["clip_id"], "user_id": ctx.user_id})
    if clip is None or clip.get("deleted_at"):
        raise PermanentError("O corte foi removido.")
    if clip["status"] == "ready":
        return {"clip_id": clip["_id"]}
    video = await ctx.db.videos.find_one({"_id": clip["video_id"], "user_id": ctx.user_id})
    if video is None or video["status"] != "ready":
        raise PermanentError("O vídeo de origem não está disponível.")
    src = await _download_source(ctx, video["source_key"])
    await _render(ctx, src, clip, 5, 95)
    return {"clip_id": clip["_id"]}


async def cleanup_after(ctx: JobContext, outcome: str) -> None:
    """Depois de cancelar ou falhar de vez: cortes que não ficaram prontos são descartados."""
    payload = ctx.job.get("payload", {})
    if payload.get("credits"):
        # Créditos de IA reservados no pedido voltam para a pessoa.
        from clipo_api.services.ai import credits

        await credits.refund(ctx.db, ctx.user_id, payload["credits"], payload.get("credits_month"))
    if ctx.job["type"] in ("video.transcribe", "video.highlights"):
        await ctx.db.transcripts.update_one(
            {"_id": payload.get("video_id"), "status": "processing"}, {"$set": {"status": "failed"}}
        )
    if ctx.job["type"] == "video.split":
        pending = await ctx.db.clips.find({"job_id": ctx.id, "status": {"$ne": "ready"}}).to_list()
        for clip in pending:
            if outcome == "cancelled":
                await ctx.db.clips.delete_one({"_id": clip["_id"]})
            else:
                await ctx.db.clips.update_one({"_id": clip["_id"]}, {"$set": {"status": "failed"}})
    elif ctx.job["type"] == "clip.render" and outcome in ("cancelled", "failed"):
        await ctx.db.clips.update_one(
            {"_id": ctx.job["payload"]["clip_id"], "status": {"$ne": "ready"}},
            {"$set": {"status": "failed" if outcome == "failed" else "cancelled"}},
        )
    elif ctx.job["type"] == "publication.publish":
        from clipo_api.services.publications import on_job_failed

        await on_job_failed(ctx.db, ctx.job, outcome)
    elif ctx.job["type"] == "video.ingest" and outcome == "failed":
        await ctx.db.videos.update_one(
            {"_id": ctx.job["payload"]["video_id"], "status": {"$nin": ["ready", "rejected"]}},
            {"$set": {"status": "failed", "error": ctx.job.get("error") or "Falha no processamento"}},
        )


async def _diagnostic(ctx: JobContext) -> dict[str, Any]:
    from clipo_api.services.diagnostics import run_diagnostic

    return await run_diagnostic(ctx)


async def _transcribe(ctx: JobContext) -> dict[str, Any]:
    from clipo_api.services.transcription import transcribe_job

    return await transcribe_job(ctx)


async def _highlights(ctx: JobContext) -> dict[str, Any]:
    from clipo_api.services.ai.tasks import highlights_job

    return await highlights_job(ctx)


async def _burn_subtitles(ctx: JobContext) -> dict[str, Any]:
    from clipo_api.services.ai.tasks import burn_subtitles_job

    return await burn_subtitles_job(ctx)


async def _publish(ctx: JobContext) -> dict[str, Any]:
    from clipo_api.services.publications import publish

    return await publish(ctx)


async def _asset(ctx: JobContext) -> dict[str, Any]:
    from clipo_api.services.assets import process

    return await process(ctx)


async def _webhook(ctx: JobContext) -> dict[str, Any]:
    from clipo_api.services.webhooks import deliver

    return await deliver(ctx)


HANDLERS: dict[str, Callable[[JobContext], Awaitable[dict[str, Any]]]] = {
    "asset.process": _asset,
    "webhook.deliver": _webhook,
    "video.ingest": ingest,
    "video.split": split,
    "clip.render": render_clip,
    "diagnostic.run": _diagnostic,
    "publication.publish": _publish,
    "video.transcribe": _transcribe,
    "video.highlights": _highlights,
    "clip.subtitles": _burn_subtitles,
}

DONE_MESSAGES = {
    "asset.process": "Ativo pronto",
    "webhook.deliver": "Webhook entregue",
    "video.ingest": "Vídeo pronto",
    "video.split": "Cortes prontos",
    "clip.render": "Corte pronto",
    "diagnostic.run": "Diagnóstico concluído",
    "publication.publish": "Publicação enviada",
    "video.transcribe": "Transcrição pronta",
    "video.highlights": "Sugestões de corte prontas",
    "clip.subtitles": "Legendas gravadas",
}


async def cancelled_in_queue(db: AsyncDatabase, job: dict[str, Any]) -> None:
    """Job cancelado ainda na fila (nenhum worker vai rodar a limpeza): faz aqui o mesmo que o worker."""
    if job.get("status") != "cancelled":
        return
    ctx = JobContext(db=db, job=job, worker_id="", scratch=Path("."))
    await cleanup_after(ctx, "cancelled")

"""Worker: processa a fila de jobs (vídeos e cortes) e as tarefas de manutenção.

    cd apps/api && uv run python -m clipo_api.worker

Roda em outro container, separado da API: um vídeo pesado nunca deixa a API lenta.
"""

import asyncio
import contextlib
import logging
import os
import shutil
import signal
import socket
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from clipo_api.core.config import get_settings
from clipo_api.core.middleware import configure_logging
from clipo_api.db.mongo import create_client, ensure_schema
from clipo_api.observability import logs
from clipo_api.observability.logs import record
from clipo_api.services import (
    analytics,
    billing,
    jobs,
    notifications,
    processing,
    publications,
    storage,
    webhooks,
)
from clipo_api.services.account_lifecycle import purge_due_accounts
from clipo_api.services.connections import refresh_expiring
from clipo_api.services.processing import JobCancelled, JobContext, PermanentError

log = logging.getLogger("clipo.worker")

HEARTBEAT_SECONDS = 10
IDLE_SECONDS = 2
MAINTENANCE_EVERY = timedelta(minutes=10)
SCHEDULER_SECONDS = 60
STALE_UPLOAD = timedelta(hours=24)


class LeaseLost(Exception):
    """Outro worker assumiu o job (este ficou parado tempo demais)."""


async def run_job(
    db: AsyncDatabase,
    job: dict[str, Any],
    worker_id: str,
    scratch_root: Path,
    *,
    deadline: float | None = None,
) -> str:
    """Executa um job já reservado. Devolve o estado final (done, failed, queued, cancelled, yielded)."""
    handler = processing.HANDLERS.get(job["type"])
    scratch = Path(tempfile.mkdtemp(prefix=f"{job['_id']}-", dir=scratch_root))
    ctx = JobContext(db=db, job=job, worker_id=worker_id, scratch=scratch, deadline=deadline)
    stop = asyncio.Event()

    async def beat() -> None:
        while not stop.is_set():
            await asyncio.sleep(HEARTBEAT_SECONDS)
            current = await jobs.heartbeat(db, job["_id"], worker_id)
            if current is None:
                ctx.cancelled = True  # perdeu o job: para de trabalhar nele
                raise LeaseLost
            if current.get("cancel_requested") and not ctx.cancelled:
                ctx.cancelled = True
                if ctx.process and ctx.process.returncode is None:
                    ctx.process.kill()

    beat_task = asyncio.create_task(beat())
    try:
        if handler is None:
            raise PermanentError(f"tipo de job desconhecido: {job['type']}")
        result = await handler(ctx)
        if ctx.cancelled:
            raise JobCancelled
        await jobs.finish(db, job["_id"], processing.DONE_MESSAGES.get(job["type"], "Concluído"), result)
        if job["type"] in webhooks.JOB_EVENTS:
            await webhooks.emit(
                db,
                job["user_id"],
                webhooks.JOB_EVENTS[job["type"]],
                {k: v for k, v in job["payload"].items() if k in ("video_id", "clip_id")}
                | {"job_id": job["_id"]},
            )
        if job["type"] in ("video.ingest", "video.split", "clip.render", "clip.subtitles"):
            try:
                await notifications.storage_check(db, job["user_id"])
            except Exception:
                log.exception("falha ao conferir o espaço do plano")
        return "done"
    except processing.Yield:
        await jobs.requeue(db, job["_id"])
        return "yielded"
    except JobCancelled:
        if beat_task.done() and isinstance(beat_task.exception(), LeaseLost):
            return "lost"
        await jobs.mark_cancelled(db, job["_id"])
        await processing.cleanup_after(ctx, "cancelled")
        await record(
            "job",
            f"{job['type']}.cancelled",
            "Job cancelado",
            user_id=job["user_id"],
            details={"job_id": job["_id"]},
        )
        return "cancelled"
    except Exception as exc:
        if ctx.cancelled and not (beat_task.done() and isinstance(beat_task.exception(), LeaseLost)):
            # O FFmpeg morto pelo cancelamento cai aqui como erro de mídia.
            await jobs.mark_cancelled(db, job["_id"])
            await processing.cleanup_after(ctx, "cancelled")
            return "cancelled"
        permanent = isinstance(exc, PermanentError)
        message = str(exc) if permanent else f"{type(exc).__name__}: {exc}"
        outcome = await jobs.fail(db, job, message, retryable=not permanent)
        if outcome == "failed":
            job["error"] = message
            await processing.cleanup_after(ctx, "failed")
        await record(
            "job",
            f"{job['type']}.{'retry' if outcome == 'queued' else 'failed'}",
            message[:300],
            level="warning" if outcome == "queued" else "error",
            outcome="failure",
            user_id=job["user_id"],
            details={"job_id": job["_id"], "attempt": job["attempts"]},
        )
        return outcome
    finally:
        stop.set()
        beat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, LeaseLost):
            await beat_task
        shutil.rmtree(scratch, ignore_errors=True)


# ---------------------------------------------------------------- manutenção


async def purge_trash(db: AsyncDatabase) -> int:
    """Apaga de vez o que está na lixeira há mais de 7 dias (arquivos no S3 e registros)."""
    now = datetime.now(UTC)
    count = 0
    async for clip in db.clips.find({"purge_after": {"$lte": now}}):
        for key in (clip.get("key"), clip.get("thumb_key"), clip.get("subtitled_key")):
            if key:
                with contextlib.suppress(Exception):
                    await storage.delete_object(key)
        await db.clips.delete_one({"_id": clip["_id"]})
        count += 1
    async for video in db.videos.find({"purge_after": {"$lte": now}}):
        async for clip in db.clips.find({"video_id": video["_id"]}):
            for key in (clip.get("key"), clip.get("thumb_key"), clip.get("subtitled_key")):
                if key:
                    with contextlib.suppress(Exception):
                        await storage.delete_object(key)
        await db.clips.delete_many({"video_id": video["_id"]})
        await db.transcripts.delete_one({"_id": video["_id"]})
        await db.suggestions.delete_many({"video_id": video["_id"]})
        for key in (video.get("source_key"), video.get("preview_key"), video.get("thumb_key")):
            if key:
                with contextlib.suppress(Exception):
                    await storage.delete_object(key)
        await db.videos.delete_one({"_id": video["_id"]})
        count += 1
    if count:
        await record(
            "system", "trash.purged", f"{count} item(ns) apagados de vez da lixeira", outcome="success"
        )
    return count


async def abort_stale_uploads(db: AsyncDatabase) -> int:
    """Envios abandonados há mais de 24 h: o S3 descarta as partes e a cota é liberada."""
    limit = datetime.now(UTC) - STALE_UPLOAD
    count = 0
    async for upload in db.uploads.find({"status": "uploading", "created_at": {"$lt": limit}}):
        await storage.abort_multipart(upload["key"], upload["s3_upload_id"])
        await db.uploads.update_one({"_id": upload["_id"]}, {"$set": {"status": "aborted"}})
        count += 1
    if count:
        await record(
            "system", "uploads.aborted", f"{count} envio(s) abandonado(s) descartados", outcome="success"
        )
    return count


async def maintenance(db: AsyncDatabase, worker_id: str) -> bool:
    """Uma vez a cada 10 min, por um worker só (trava no banco)."""
    now = datetime.now(UTC)
    try:
        lock = await db.locks.find_one_and_update(
            {"_id": "maintenance", "until": {"$lt": now}},
            {"$set": {"until": now + MAINTENANCE_EVERY, "worker_id": worker_id}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        return False  # outro worker está com a vez
    if lock is None:
        return False
    for task in (purge_due_accounts, purge_trash, abort_stale_uploads, refresh_expiring, billing.sweep):
        try:
            await task(db)
        except Exception:
            log.exception("falha na manutenção: %s", task.__name__)
    return True


async def scheduler_tick(db: AsyncDatabase) -> None:
    """A cada minuto: publica o que venceu, consulta o que ainda está processando e coleta métricas."""
    # Sinal de vida do worker (a tela Sistema mostra há quanto tempo foi visto).
    await db.worker_status.update_one(
        {"_id": socket.gethostname()}, {"$set": {"seen_at": datetime.now(UTC)}}, upsert=True
    )
    for task in (publications.schedule_due, publications.poll_processing, analytics.collect_due):
        try:
            await task(db)
        except Exception:
            log.exception("falha no agendador: %s", task.__name__)


# ---------------------------------------------------------------- Vercel: worker em fatias


async def run_slice(db: AsyncDatabase, *, budget: float, user_id: str | None = None) -> dict[str, Any]:
    """Roda jobs da fila até acabar o tempo da fatia. Na Vercel não existe worker ligado o tempo todo:
    cada requisição de /jobs/pump (ou a tarefa agendada) avança um pouco a fila."""
    import time as _time

    deadline = _time.monotonic() + budget
    worker_id = f"slice-{uuid4().hex[:8]}"
    scratch_root = Path(tempfile.gettempdir()) / "clipo-jobs"
    scratch_root.mkdir(parents=True, exist_ok=True)
    outcomes: list[str] = []
    # Margem para salvar o estado antes de a função ser encerrada.
    while _time.monotonic() < deadline - 8:
        job = await jobs.claim(db, worker_id, user_id=user_id)
        if job is None:
            break
        outcomes.append(await run_job(db, job, worker_id, scratch_root, deadline=deadline - 8))
    return {"ran": len(outcomes), "outcomes": outcomes}


async def scheduler_tick_throttled(db: AsyncDatabase, every_seconds: int = 55) -> bool:
    """Agendador uma vez por minuto no máximo, mesmo com várias requisições ao mesmo tempo."""
    now = datetime.now(UTC)
    try:
        lock = await db.locks.find_one_and_update(
            {"_id": "scheduler", "until": {"$lt": now}},
            {"$set": {"until": now + timedelta(seconds=every_seconds)}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        return False
    if lock is None:
        return False
    await scheduler_tick(db)
    return True


# ---------------------------------------------------------------- laço principal


async def worker_loop(db: AsyncDatabase, worker_id: str, scratch_root: Path, stopping: asyncio.Event) -> None:
    while not stopping.is_set():
        job = await jobs.claim(db, worker_id)
        if job is None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), timeout=IDLE_SECONDS)
            continue
        log.info("job %s (%s) tentativa %s", job["_id"], job["type"], job["attempts"])
        if job["attempts"] > 1:
            # Nova tentativa depois de uma falha, ou retomada de um worker que caiu.
            await record(
                "job",
                f"{job['type']}.resumed",
                f"Job retomado (tentativa {job['attempts']} de {job['max_attempts']})",
                level="warning",
                user_id=job["user_id"],
                details={"job_id": job["_id"], "progress": job.get("progress"), "worker_id": worker_id},
            )
        await run_job(db, job, worker_id, scratch_root)


async def main() -> None:
    configure_logging()
    settings = get_settings()
    client = create_client()
    db = client[settings.mongodb_db]
    await ensure_schema(db)
    logs.configure(db)
    worker_id = f"{socket.gethostname()}-{uuid4().hex[:6]}"
    scratch_root = Path(os.environ.get("WORKER_SCRATCH", tempfile.gettempdir())) / "clipo-jobs"
    scratch_root.mkdir(parents=True, exist_ok=True)
    concurrency = max(1, int(os.environ.get("WORKER_CONCURRENCY", "2")))

    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopping.set)

    await record(
        "system",
        "worker.started",
        f"Worker iniciado ({concurrency} em paralelo)",
        details={"worker_id": worker_id},
    )

    async def maintenance_loop() -> None:
        while not stopping.is_set():
            await scheduler_tick(db)
            await maintenance(db, worker_id)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), timeout=SCHEDULER_SECONDS)

    await asyncio.gather(
        maintenance_loop(), *(worker_loop(db, worker_id, scratch_root, stopping) for _ in range(concurrency))
    )
    await record("system", "worker.stopped", "Worker parado", details={"worker_id": worker_id})
    logs.configure(None)
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())

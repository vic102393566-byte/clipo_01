"""Tarefas de IA: metadados a partir da fala, cortes inteligentes e legendas gravadas no corte."""

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import uuid4

from pydantic import BaseModel, Field
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.observability.logs import record
from clipo_api.services import media, storage, subtitles, transcription
from clipo_api.services import settings as settings_service
from clipo_api.services.ai import gateway

TONES = {
    "viral": "alto apelo de retenção, gancho irresistível e curiosidade imediata",
    "educativo": "didático, claro, com valor prático e autoridade",
    "persuasivo": "focado em conversão, benefício e engajamento ativo",
    "minimalista": "direto ao ponto, sofisticado e conciso",
}
WINDOW_SECONDS = 25 * 60  # transcrições longas vão para a IA em janelas


class Metadata(BaseModel):
    title: Annotated[str, Field(description="Título curto e atrativo (até 70 caracteres).")]
    description: Annotated[str, Field(description="Descrição de 2 a 4 frases.")]
    hashtags: Annotated[list[str], Field(description="5 a 8 hashtags começando com #.")]
    call_to_action: Annotated[str, Field(description="Frase pedindo engajamento.")]


class Suggestion(BaseModel):
    start_s: Annotated[float, Field(description="Início do trecho, em segundos.")]
    end_s: Annotated[float, Field(description="Fim do trecho, em segundos.")]
    title: Annotated[str, Field(description="Título curto do corte.")]
    hook: Annotated[str, Field(description="Primeira frase do corte.")]
    score: Annotated[int, Field(ge=0, le=100, description="Nota de 0 a 100.")]
    reason: Annotated[str, Field(description="Por que este trecho funciona, em uma frase.")]


class Suggestions(BaseModel):
    suggestions: list[Suggestion]


def _clock(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


# ---------------------------------------------------------------- metadados


async def metadata(
    db: AsyncDatabase,
    user_id: str,
    *,
    title: str,
    duration_s: float,
    transcript_text: str,
    platforms: list[str],
    tone: str,
    context: str,
    ref: dict[str, Any],
) -> dict[str, Any]:
    result = await gateway.run(
        db,
        "metadata",
        Metadata,
        {
            "title": title or "Sem título",
            "duration": _clock(duration_s) if duration_s else "não informada",
            "platforms": ", ".join(platforms) or "TikTok, Instagram Reels, YouTube Shorts",
            "tone": TONES.get(tone, TONES["viral"]),
            "context": context or "nenhuma",
            "transcript": transcript_text or "(sem transcrição: use só o título)",
        },
        user_id=user_id,
        ref=ref,
    )
    data: Metadata = result.data
    tags = [
        t if t.startswith("#") else f"#{t}" for t in (x.strip().replace(" ", "") for x in data.hashtags) if t
    ]
    return {
        "title": data.title.strip()[:100] or title,
        "description": data.description.strip(),
        "hashtags": tags[:10],
        "call_to_action": data.call_to_action.strip(),
        "call_id": result.call_id,
        "model": f"{result.provider}:{result.model}",
        "prompt": result.prompt_id,
        "cost_usd": result.cost_usd,
        "used_transcript": bool(transcript_text),
    }


# ---------------------------------------------------------------- cortes inteligentes


def _snap(words: list[dict[str, Any]], start: float, end: float) -> tuple[float, float]:
    """Encaixa o trecho no começo e no fim de palavras (não corta no meio de uma palavra)."""
    if not words:
        return start, end
    starts = [w for w in words if w["s"] <= start + 0.15]
    s = starts[-1]["s"] if starts else words[0]["s"]
    ends = [w for w in words if w["e"] >= end - 0.15]
    e = ends[0]["e"] if ends else words[-1]["e"]
    return max(0.0, s - 0.1), e + 0.3


def clean_suggestions(
    raw: list[Suggestion], words: list[dict[str, Any]], duration: float, min_s: int, max_s: int, count: int
) -> list[dict[str, Any]]:
    """Valida o que a IA devolveu: dentro do vídeo, no tamanho pedido, sem sobreposição."""
    out: list[dict[str, Any]] = []
    for s in sorted(raw, key=lambda x: x.score, reverse=True):
        start, end = max(0.0, s.start_s), min(duration, s.end_s)
        if end <= start:
            continue
        if end - start > max_s:
            end = start + max_s
        if end - start < min_s:
            end = min(duration, start + min_s)
            if end - start < min_s:
                continue
        start, end = _snap(words, start, end)
        end = min(end, duration, start + max_s + 1)
        overlaps = any(min(end, o["end_s"]) - max(start, o["start_s"]) > 0.3 * (end - start) for o in out)
        if overlaps:
            continue
        out.append(
            {
                "start_s": round(start, 2),
                "end_s": round(end, 2),
                "title": s.title.strip()[:100],
                "hook": s.hook.strip()[:300],
                "score": s.score,
                "reason": s.reason.strip()[:400],
            }
        )
        if len(out) == count:
            break
    return out


def _windows(segments: list[dict[str, Any]], duration: float) -> list[tuple[float, float, str]]:
    windows = []
    start = 0.0
    while start < max(duration, 1):
        end = start + WINDOW_SECONDS
        lines = [f"[{seg['start']:.0f}] {seg['text']}" for seg in segments if start <= seg["start"] < end]
        if lines:
            windows.append((start, end, "\n".join(lines)))
        start = end
    return windows


async def highlights_job(ctx: Any) -> dict[str, Any]:
    from clipo_api.services.processing import PermanentError

    db, payload = ctx.db, ctx.job["payload"]
    video = await db.videos.find_one({"_id": payload["video_id"], "user_id": ctx.user_id})
    if video is None or video.get("deleted_at") or video["status"] != "ready":
        raise PermanentError("O vídeo não está disponível.")
    transcript = await transcription.ensure(ctx, video, 0, 70)
    segments = transcript["segments"]
    if not segments:
        raise PermanentError("Não há fala no vídeo para escolher os melhores trechos.")
    words = [w for seg in segments for w in seg["words"]]
    duration = float(video["duration_s"])
    count, min_s, max_s = payload["count"], payload["min_s"], payload["max_s"]
    windows = _windows(segments, duration)
    raw: list[Suggestion] = []
    call_ids = []
    for i, (_, _, text) in enumerate(windows):
        ctx.check()
        await ctx.progress(70 + 25 * i / len(windows), "A IA está escolhendo os melhores trechos")
        result = await gateway.run(
            db,
            "highlights",
            Suggestions,
            {
                "count": count if len(windows) == 1 else max(2, count // len(windows) + 1),
                "title": video["title"],
                "duration": _clock(duration),
                "transcript": text,
                "min_s": min_s,
                "max_s": max_s,
            },
            user_id=ctx.user_id,
            ref={"video_id": video["_id"], "job_id": ctx.id, "window": i},
        )
        raw += result.data.suggestions
        call_ids.append(result.call_id)
    chosen = clean_suggestions(raw, words, duration, min_s, max_s, count)
    now = datetime.now(UTC)
    docs = [
        {
            "_id": uuid4().hex,
            "user_id": ctx.user_id,
            "video_id": video["_id"],
            "job_id": ctx.id,
            **s,
            "call_ids": call_ids,
            "status": "new",
            "clip_id": None,
            "created_at": now,
        }
        for s in chosen
    ]
    await db.suggestions.delete_many({"job_id": ctx.id})  # retomada: não duplica
    if docs:
        await db.suggestions.insert_many(docs)
    await record(
        "ai",
        "highlights.ready",
        f"{len(docs)} sugestões de corte (pedidas {count}, a IA mandou {len(raw)})",
        outcome="success",
        user_id=ctx.user_id,
        details={"video_id": video["_id"], "scores": [d["score"] for d in docs], "calls": call_ids},
    )
    return {"video_id": video["_id"], "suggestions": len(docs)}


# ---------------------------------------------------------------- legendas gravadas no corte


async def burn_subtitles_job(ctx: Any) -> dict[str, Any]:
    from clipo_api.services.processing import PermanentError

    db, payload = ctx.db, ctx.job["payload"]
    clip = await db.clips.find_one({"_id": payload["clip_id"], "user_id": ctx.user_id})
    if clip is None or clip.get("deleted_at") or clip["status"] != "ready":
        raise PermanentError("O corte não está disponível.")
    if not await media.can_burn_subtitles():
        raise PermanentError("O FFmpeg do servidor não tem a libass para gravar legendas.")
    transcript = await db.transcripts.find_one({"_id": clip["video_id"], "status": "ready"})
    if transcript is None:
        raise PermanentError("Transcreva o vídeo antes de gravar as legendas.")
    words = transcription.words_between(transcript, clip["start_s"], clip["end_s"])
    if not words:
        raise PermanentError("Não há fala neste trecho para legendar.")
    prefs = await settings_service.workspace(db, ctx.user_id)
    if prefs["ai"]["filter_profanity"]:
        words = [{**w, "w": settings_service.mask_profanity(w["w"])} for w in words]
    await ctx.progress(5, "Baixando o corte")
    src = ctx.scratch / "clip.mp4"
    if not src.exists():
        await storage.download(clip["key"], src)
    info = await media.probe(src)
    style = subtitles.resolve_style(payload["preset"], payload.get("overrides") or {})
    ass = ctx.scratch / "legenda.ass"
    ass.write_text(
        subtitles.to_ass(
            subtitles.cues(words, offset=clip["start_s"], max_chars=payload.get("max_chars", 28)),
            style,
            info.width or 1080,
            info.height or 1920,
        ),
        encoding="utf-8",
    )
    out = ctx.scratch / "legendado.mp4"
    escaped = str(ass).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    video_filter = f"ass=filename={escaped}"
    mark = prefs["render"]["watermark"]
    if mark["enabled"] and mark["text"].strip():
        video_filter += "," + subtitles.watermark_filter(mark["text"], mark["opacity"], mark["position"])
    await media.run_ffmpeg(
        [
            "-y",
            "-i",
            str(src),
            "-vf",
            video_filter,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-map_metadata",
            "-1",
            "-movflags",
            "+faststart",
            str(out),
        ],
        timeout=1800,
        total_seconds=info.duration,
        on_start=ctx.attach,
        on_progress=ctx.scaled(10, 90, "Gravando as legendas"),
    )
    ctx.check()
    key = f"{storage.user_prefix(ctx.user_id)}clips/{clip['_id']}-legendado.mp4"
    await storage.upload(out, key, "video/mp4")
    await db.clips.update_one(
        {"_id": clip["_id"]},
        {
            "$set": {
                "subtitled_key": key,
                "subtitled_size": out.stat().st_size,
                "subtitle_style": payload["preset"],
                "subtitled_at": datetime.now(UTC),
            }
        },
    )
    await record(
        "video",
        "clip.subtitled",
        f"Legendas gravadas no corte ({payload['preset']})",
        outcome="success",
        user_id=ctx.user_id,
        details={"clip_id": clip["_id"], "words": len(words)},
    )
    return {"clip_id": clip["_id"]}

"""Transcrição com o tempo de cada palavra (job `video.transcribe` do worker).

Dois provedores:
- local: faster-whisper rodando no próprio worker (sem custo, o áudio não sai do servidor).
  O modelo é baixado uma vez para WHISPER_MODELS_DIR e fica em memória no worker.
- openai: API no formato da OpenAI (/audio/transcriptions com tempos por palavra). Serve para a
  OpenAI e para servidores compatíveis. O áudio vai em partes de 10 min (limite de 25 MB da API),
  e cada parte pronta fica guardada: se o worker cair, a retomada pula o que já foi feito.

Formato guardado em `transcripts` (um por vídeo, `_id` = id do vídeo):
segments: [{start, end, text, words: [{s, e, w}]}] — tempos em segundos.
"""

import asyncio
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from clipo_api.core.config import get_settings
from clipo_api.observability.http import LoggedClient
from clipo_api.observability.logs import record
from clipo_api.services import media
from clipo_api.services.ai import config as ai_config
from clipo_api.services.ai import gateway

CHUNK_SECONDS = 600
# Os testes trocam o transporte para simular a API de transcrição.
HTTP_TRANSPORT: Any = None
_whisper_lock = threading.Lock()
_whisper_model: Any = None
_whisper_name: str | None = None


def _local_model() -> Any:
    """Carrega o faster-whisper uma vez por processo (o carregamento leva segundos)."""
    global _whisper_model, _whisper_name
    s = get_settings()
    with _whisper_lock:
        if _whisper_model is None or _whisper_name != s.local_whisper_model:
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                # Na Vercel o Whisper local não cabe na função: use a API (STT_PROVIDER=openai).
                raise RuntimeError(
                    "Transcrição local indisponível neste servidor. Defina STT_PROVIDER=openai e STT_API_KEY."
                ) from exc

            _whisper_model = WhisperModel(
                s.local_whisper_model, device="cpu", compute_type="int8", download_root=s.whisper_models_dir
            )
            _whisper_name = s.local_whisper_model
    return _whisper_model


def _read_wav(path: Path) -> Any:
    """WAV 16 kHz mono (extraído pelo FFmpeg) → amostras float32, o formato que o Whisper espera.

    Ler direto evita a decodificação do próprio faster-whisper (PyAV), que quebra entre versões.
    """
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as f:
        frames = f.readframes(f.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def _local_transcribe(
    path: Path,
    duration: float,
    progress: dict[str, float],
    stop: threading.Event,
    language: str | None = None,
) -> dict:
    """Roda numa thread. Atualiza `progress["fraction"]` e para se `stop` for ligado (cancelamento)."""
    model = _local_model()
    # O VAD tira o silêncio antes; sem o corte por "não é fala" o Whisper não descarta janelas
    # inteiras de 30 s (acontecia com voz sintetizada e com áudio comprimido).
    segments_iter, info = model.transcribe(
        _read_wav(path),
        language=language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=1,
        no_speech_threshold=None,
    )
    segments = []
    for seg in segments_iter:
        if stop.is_set():
            raise InterruptedError
        words = [
            {"s": round(w.start, 2), "e": round(w.end, 2), "w": w.word.strip()} for w in (seg.words or [])
        ]
        segments.append(
            {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip(), "words": words}
        )
        progress["fraction"] = min(1.0, seg.end / max(duration, 1))
    return {"language": info.language, "segments": segments}


def _attach_words(segments: list[dict], words: list[dict]) -> list[dict]:
    """A API devolve frases e palavras separadas: cada palavra vai para a frase em que ela cai."""
    out = [{"start": s["start"], "end": s["end"], "text": s["text"].strip(), "words": []} for s in segments]
    i = 0
    for w in words:
        mid = (w["s"] + w["e"]) / 2
        while i < len(out) - 1 and mid > out[i]["end"]:
            i += 1
        if out:
            out[i]["words"].append(w)
    return out


async def _api_chunk(path: Path, offset: float, language: str | None = None) -> dict:
    s = get_settings()
    key = s.stt_api_key or s.openai_api_key
    content = await asyncio.to_thread(path.read_bytes)
    async with LoggedClient(
        platform="stt", category="ai", base_url=s.stt_base_url, timeout=300, transport=HTTP_TRANSPORT
    ) as http:
        resp = await http.post(
            "/audio/transcriptions",
            headers={"Authorization": f"Bearer {key}"},
            data={
                "model": s.stt_model,
                **({"language": language} if language else {}),
                "response_format": "verbose_json",
                "timestamp_granularities[]": ["word", "segment"],
            },
            files={"file": (path.name, content, "audio/mpeg")},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"transcrição falhou (HTTP {resp.status_code})")
    data = resp.json()
    words = [
        {"s": round(w["start"] + offset, 2), "e": round(w["end"] + offset, 2), "w": str(w["word"]).strip()}
        for w in data.get("words") or []
    ]
    segments = [
        {
            "start": round(x["start"] + offset, 2),
            "end": round(x["end"] + offset, 2),
            "text": x.get("text", ""),
        }
        for x in data.get("segments") or []
    ] or ([{"start": offset, "end": offset + float(data.get("duration") or 0), "text": data.get("text", "")}])
    return {"language": data.get("language"), "segments": _attach_words(segments, words)}


def configured() -> bool:
    s = get_settings()
    return s.stt_provider == "local" or bool(s.stt_api_key or s.openai_api_key)


async def ensure(
    ctx: Any, video: dict[str, Any], start_pct: float = 0, end_pct: float = 100
) -> dict[str, Any]:
    """Transcreve o vídeo se ainda não tiver transcrição pronta. Devolve a transcrição."""
    from clipo_api.services.processing import PermanentError, _download_source

    db = ctx.db
    existing = await db.transcripts.find_one({"_id": video["_id"]})
    if existing and existing.get("status") == "ready":
        return existing
    s = get_settings()
    if not configured():
        raise PermanentError("A transcrição não está configurada no servidor.")
    provider = s.stt_provider
    # Idioma da fala (o automático erra em trechos curtos ou voz sintetizada). None = detectar.
    language_hint = ctx.job["payload"].get("language")
    model = s.local_whisper_model if provider == "local" else s.stt_model
    if provider != "local":
        await gateway.check_budget(db, "transcription", ctx.user_id)
    duration = float(video.get("duration_s") or 0)
    await db.transcripts.update_one(
        {"_id": video["_id"]},
        {
            "$set": {
                "status": "processing",
                "provider": provider,
                "model": model,
                "updated_at": datetime.now(UTC),
            },
            "$setOnInsert": {
                "user_id": ctx.user_id,
                "video_id": video["_id"],
                "chunks": {},
                "created_at": datetime.now(UTC),
            },
        },
        upsert=True,
    )
    span = end_pct - start_pct
    await ctx.progress(start_pct, "Preparando o áudio")
    src = await _download_source(ctx, video["source_key"])
    started = time.perf_counter()

    if provider == "local":
        audio = ctx.scratch / "audio.wav"
        if not audio.exists():
            await media.run_ffmpeg(
                ["-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio)],
                timeout=1800,
                total_seconds=duration,
                on_start=ctx.attach,
                on_progress=ctx.scaled(start_pct, start_pct + span * 0.1, "Extraindo o áudio"),
            )
        progress = {"fraction": 0.0}
        stop = threading.Event()
        task = asyncio.create_task(
            asyncio.to_thread(_local_transcribe, audio, duration, progress, stop, language_hint)
        )
        while not task.done():
            await asyncio.wait({task}, timeout=2)
            if ctx.cancelled:
                stop.set()
            await ctx.progress(start_pct + span * (0.1 + 0.85 * progress["fraction"]), "Transcrevendo")
        try:
            result = task.result()
        except InterruptedError:
            ctx.check()
            raise
        language, segments = result["language"], result["segments"]
    else:
        chunk_dir = ctx.scratch / "chunks"
        if not chunk_dir.exists():
            chunk_dir.mkdir()
            await media.run_ffmpeg(
                [
                    "-y",
                    "-i",
                    str(src),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "32k",
                    "-f",
                    "segment",
                    "-segment_time",
                    str(CHUNK_SECONDS),
                    str(chunk_dir / "part%03d.mp3"),
                ],
                timeout=1800,
                total_seconds=duration,
                on_start=ctx.attach,
                on_progress=ctx.scaled(start_pct, start_pct + span * 0.1, "Extraindo o áudio"),
            )
        parts = sorted(chunk_dir.glob("part*.mp3"))
        done = (await db.transcripts.find_one({"_id": video["_id"]}, projection={"chunks": 1}) or {}).get(
            "chunks"
        ) or {}
        language = None
        for index, part in enumerate(parts):
            ctx.check()
            if str(index) in done:
                language = language or done[str(index)].get("language")
                continue
            await ctx.progress(
                start_pct + span * (0.1 + 0.85 * index / len(parts)),
                f"Transcrevendo parte {index + 1} de {len(parts)}",
            )
            chunk_started = time.perf_counter()
            piece = await _api_chunk(part, index * CHUNK_SECONDS, language_hint)
            minutes = min(CHUNK_SECONDS, max(0.0, duration - index * CHUNK_SECONDS)) / 60
            conf = await ai_config.load(db)
            await gateway.log_external(
                db,
                "transcription",
                user_id=ctx.user_id,
                provider=provider,
                model=model,
                cost=ai_config.stt_cost_usd(conf, provider, model, minutes),
                ms=(time.perf_counter() - chunk_started) * 1000,
                ref={"video_id": video["_id"], "job_id": ctx.id, "part": index},
                units={"minutes": round(minutes, 2)},
            )
            done[str(index)] = piece
            await db.transcripts.update_one({"_id": video["_id"]}, {"$set": {f"chunks.{index}": piece}})
            language = language or piece.get("language")
        segments = [seg for i in range(len(parts)) for seg in done[str(i)]["segments"]]

    if provider == "local":
        await gateway.log_external(
            db,
            "transcription",
            user_id=ctx.user_id,
            provider="local",
            model=model,
            cost=0.0,
            ms=(time.perf_counter() - started) * 1000,
            ref={"video_id": video["_id"], "job_id": ctx.id},
            units={"minutes": round(duration / 60, 2)},
        )
    words = sum(len(s["words"]) for s in segments)
    doc = {
        "status": "ready",
        "language": language,
        "duration_s": duration,
        "segments": segments,
        "word_count": words,
        "ready_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }
    await db.transcripts.update_one({"_id": video["_id"]}, {"$set": doc, "$unset": {"chunks": ""}})
    await record(
        "ai",
        "transcription.ready",
        f"Transcrição pronta: {words} palavras ({language or '?'})",
        outcome="success",
        user_id=ctx.user_id,
        duration_ms=(time.perf_counter() - started) * 1000,
        details={
            "video_id": video["_id"],
            "provider": provider,
            "model": model,
            "words": words,
            "segments": len(segments),
        },
    )
    await ctx.progress(end_pct, "Transcrição pronta")
    return {**doc, "_id": video["_id"]}


async def transcribe_job(ctx: Any) -> dict[str, Any]:
    from clipo_api.services.processing import PermanentError

    video = await ctx.db.videos.find_one({"_id": ctx.job["payload"]["video_id"], "user_id": ctx.user_id})
    if video is None or video.get("deleted_at") or video["status"] != "ready":
        raise PermanentError("O vídeo não está disponível.")
    result = await ensure(ctx, video)
    return {"video_id": video["_id"], "words": result["word_count"]}


def words_between(transcript: dict[str, Any], start: float, end: float) -> list[dict[str, Any]]:
    return [
        w
        for seg in transcript.get("segments", [])
        for w in seg["words"]
        if w["s"] >= start - 0.05 and w["e"] <= end + 0.05
    ]


def text_between(transcript: dict[str, Any], start: float, end: float, limit: int = 12000) -> str:
    text = " ".join(w["w"] for w in words_between(transcript, start, end))
    if not text:  # provedor sem palavras: usa as frases
        text = " ".join(
            s["text"] for s in transcript.get("segments", []) if s["end"] > start and s["start"] < end
        )
    return text[:limit]

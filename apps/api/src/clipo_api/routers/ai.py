"""API v1 de IA: transcrição, legendas, cortes inteligentes, metadados, créditos e o admin da IA.

Substitui a rota antiga /api/ai/generate-metadata (que só olhava o título).
"""

import math
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, model_validator
from pymongo import ReturnDocument

from clipo_api.core.errors import ApiError
from clipo_api.core.permissions import Requires
from clipo_api.core.ratelimit import hit
from clipo_api.core.workspace import WsEditor, WsUser, WsWriter
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.routers import templates
from clipo_api.routers.library import _clip_out, enqueue_clip
from clipo_api.services import crypto, jobs, subtitles, transcription
from clipo_api.services.ai import config as ai_config
from clipo_api.services.ai import credits, tasks
from clipo_api.services.ai.prompts import DEFAULT_PROMPTS

router = APIRouter(prefix="/api/v1", tags=["ia"])

Platform = Literal["youtube", "instagram", "tiktok", "linkedin"]
Tone = Literal["viral", "educativo", "persuasivo", "minimalista"]


def _not_found(what: str) -> ApiError:
    return ApiError(status.HTTP_404_NOT_FOUND, "not_found", f"{what} não encontrado.")


async def _video(db: MongoDb, video_id: str, user_id: str) -> dict[str, Any]:
    video = await db.videos.find_one({"_id": video_id, "user_id": user_id, "deleted_at": None})
    if video is None:
        raise _not_found("Vídeo")
    if video["status"] != "ready":
        raise ApiError(status.HTTP_409_CONFLICT, "not_ready", "O vídeo ainda está sendo processado.")
    return video


async def _clip(db: MongoDb, clip_id: str, user_id: str) -> dict[str, Any]:
    clip = await db.clips.find_one({"_id": clip_id, "user_id": user_id, "deleted_at": None})
    if clip is None:
        raise _not_found("Corte")
    return clip


def _transcription_credits(conf: dict[str, Any], duration_s: float) -> int:
    return math.ceil(max(duration_s, 1) / 60) * int(conf["credit_costs"]["transcription_per_minute"])


async def _enqueue_paid(
    db: MongoDb, job_type: str, user_id: str, payload: dict[str, Any], amount: int, reason: str
) -> dict[str, Any]:
    """Reserva os créditos e põe o job na fila. Se o job falhar de vez, os créditos voltam."""
    reserved = await credits.reserve(db, user_id, amount, reason)
    month = f"{datetime.now(UTC):%Y-%m}"
    try:
        return await jobs.enqueue(
            db, job_type, user_id, {**payload, "credits": reserved, "credits_month": month}
        )
    except Exception:
        await credits.refund(db, user_id, reserved, month)
        raise


async def _busy(db: MongoDb, job_type: str, user_id: str, video_id: str) -> dict[str, Any] | None:
    return await db.jobs.find_one(
        {
            "type": job_type,
            "user_id": user_id,
            "payload.video_id": video_id,
            "status": {"$in": ["queued", "running"]},
        }
    )


# ---------------------------------------------------------------- transcrição e legendas


Language = Literal["auto", "pt", "en", "es"]


class TranscribeIn(BaseModel):
    language: Language | None = None  # vazio: o idioma da conta


async def _language(db: MongoDb, user_id: str, chosen: str | None) -> str | None:
    """Idioma da fala para a transcrição (o automático erra em voz sintetizada ou trechos curtos)."""
    if chosen:
        return None if chosen == "auto" else chosen
    user = await db.users.find_one({"_id": user_id}, projection={"locale": 1})
    return "en" if (user or {}).get("locale") == "en-US" else "pt"


@router.post("/videos/{video_id}/transcribe", status_code=status.HTTP_202_ACCEPTED)
async def transcribe(
    video_id: str, user: WsEditor, db: MongoDb, body: TranscribeIn | None = None
) -> dict[str, Any]:
    video = await _video(db, video_id, user.id)
    existing = await db.transcripts.find_one({"_id": video_id}, projection={"status": 1})
    if existing and existing["status"] == "ready":
        raise ApiError(status.HTTP_409_CONFLICT, "already_transcribed", "Este vídeo já tem transcrição.")
    if job := await _busy(db, "video.transcribe", user.id, video_id):
        return {"job": jobs.public_job(job)}
    if not transcription.configured():
        raise ApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE, "ai_unavailable", "A transcrição não está configurada."
        )
    conf = await ai_config.load(db)
    job = await _enqueue_paid(
        db,
        "video.transcribe",
        user.id,
        {"video_id": video_id, "language": await _language(db, user.id, body.language if body else None)},
        _transcription_credits(conf, video["duration_s"]),
        "transcrição",
    )
    await record(
        "ai",
        "transcription.requested",
        "Transcrição pedida",
        details={"video_id": video_id, "job_id": job["_id"]},
    )
    return {"job": jobs.public_job(job)}


@router.get("/videos/{video_id}/transcript")
async def get_transcript(video_id: str, user: WsUser, db: MongoDb, words: bool = False) -> dict[str, Any]:
    doc = await db.transcripts.find_one({"_id": video_id, "user_id": user.id})
    if doc is None:
        raise _not_found("Transcrição")
    segments = doc.get("segments") or []
    return {
        "transcript": {
            "video_id": video_id,
            "status": doc["status"],
            "language": doc.get("language"),
            "provider": doc.get("provider"),
            "model": doc.get("model"),
            "word_count": doc.get("word_count", 0),
            "segments": segments
            if words
            else [{k: v for k, v in s.items() if k != "words"} for s in segments],
        }
    }


def _subtitle_response(items: list[subtitles.Cue], fmt: str, name: str) -> PlainTextResponse:
    body = subtitles.to_srt(items) if fmt == "srt" else subtitles.to_vtt(items)
    media_type = "application/x-subrip" if fmt == "srt" else "text/vtt"
    return PlainTextResponse(
        body,
        media_type=f"{media_type}; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}.{fmt}"'},
    )


async def _ready_transcript(db: MongoDb, video_id: str) -> dict[str, Any]:
    doc = await db.transcripts.find_one({"_id": video_id, "status": "ready"})
    if doc is None:
        raise ApiError(status.HTTP_409_CONFLICT, "no_transcript", "Transcreva o vídeo antes.")
    return doc


@router.get("/videos/{video_id}/subtitles.{fmt}")
async def video_subtitles(
    video_id: str, fmt: Literal["srt", "vtt"], user: WsUser, db: MongoDb
) -> PlainTextResponse:
    await _video(db, video_id, user.id)
    doc = await _ready_transcript(db, video_id)
    words = [w for s in doc["segments"] for w in s["words"]]
    return _subtitle_response(subtitles.cues(words, max_chars=42), fmt, f"legenda-{video_id[:8]}")


@router.get("/clips/{clip_id}/subtitles.{fmt}")
async def clip_subtitles(
    clip_id: str, fmt: Literal["srt", "vtt"], user: WsUser, db: MongoDb
) -> PlainTextResponse:
    clip = await _clip(db, clip_id, user.id)
    doc = await _ready_transcript(db, clip["video_id"])
    words = transcription.words_between(doc, clip["start_s"], clip["end_s"])
    return _subtitle_response(subtitles.cues(words, offset=clip["start_s"]), fmt, f"corte-{clip_id[:8]}")


class BurnIn(BaseModel):
    # Sem preset nem modelo: vale o modelo padrão do workspace (ou "destaque").
    preset: Literal["classico", "destaque", "minimal"] | None = None
    template_id: str | None = None
    color: Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")] | None = None
    highlight: Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")] | None = None
    size: Annotated[float, Field(ge=2, le=12)] | None = None  # % da altura do vídeo
    position: Literal["bottom", "middle", "top"] | None = None
    uppercase: bool | None = None
    max_chars: Annotated[int, Field(ge=10, le=60)] = 28


@router.post("/clips/{clip_id}/subtitles", status_code=status.HTTP_202_ACCEPTED)
async def burn_subtitles(clip_id: str, body: BurnIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    """Grava as legendas no vídeo do corte (arquivo novo; o corte original fica como está)."""
    clip = await _clip(db, clip_id, user.id)
    if clip["status"] != "ready":
        raise ApiError(status.HTTP_409_CONFLICT, "not_ready", "O corte ainda está sendo renderizado.")
    await _ready_transcript(db, clip["video_id"])
    conf = await ai_config.load(db)
    overrides = body.model_dump(exclude={"preset", "max_chars", "template_id"}, exclude_none=True)
    preset = body.preset or "destaque"
    if body.template_id or body.preset is None:
        caption = await templates.default_caption(db, user.id, body.template_id)
        if caption:
            preset = caption.get("preset", preset)
            overrides = {k: v for k, v in caption.items() if k != "preset"} | overrides
    job = await _enqueue_paid(
        db,
        "clip.subtitles",
        user.id,
        {"clip_id": clip_id, "preset": preset, "overrides": overrides, "max_chars": body.max_chars},
        int(conf["credit_costs"]["subtitles_burn"]),
        "legendas",
    )
    return {"job": jobs.public_job(job)}


# ---------------------------------------------------------------- cortes inteligentes


class HighlightsIn(BaseModel):
    language: Language | None = None
    count: Annotated[int, Field(ge=1, le=15)] = 5
    min_s: Annotated[int, Field(ge=5, le=600)] = 20
    max_s: Annotated[int, Field(ge=10, le=900)] = 75

    @model_validator(mode="after")
    def _range(self) -> "HighlightsIn":
        if self.max_s < self.min_s + 5:
            raise ValueError("A duração máxima precisa ser pelo menos 5 s maior que a mínima.")
        return self


@router.post("/videos/{video_id}/highlights", status_code=status.HTTP_202_ACCEPTED)
async def request_highlights(
    video_id: str, body: HighlightsIn, user: WsEditor, db: MongoDb
) -> dict[str, Any]:
    """A IA sugere os melhores trechos com nota e motivo. Transcreve antes, se precisar."""
    video = await _video(db, video_id, user.id)
    if job := await _busy(db, "video.highlights", user.id, video_id):
        return {"job": jobs.public_job(job)}
    conf = await ai_config.load(db)
    if not ai_config.available_models(conf, "highlights"):
        raise ApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE, "ai_unavailable", "A IA não está configurada no servidor."
        )
    amount = int(conf["credit_costs"]["highlights"])
    has_transcript = await db.transcripts.find_one(
        {"_id": video_id, "status": "ready"}, projection={"_id": 1}
    )
    if not has_transcript:
        if not transcription.configured():
            raise ApiError(
                status.HTTP_503_SERVICE_UNAVAILABLE, "ai_unavailable", "A transcrição não está configurada."
            )
        amount += _transcription_credits(conf, video["duration_s"])
    job = await _enqueue_paid(
        db,
        "video.highlights",
        user.id,
        {"video_id": video_id, **body.model_dump(), "language": await _language(db, user.id, body.language)},
        amount,
        "cortes inteligentes",
    )
    return {"job": jobs.public_job(job)}


def _suggestion_out(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": s["_id"],
        "video_id": s["video_id"],
        "start_s": s["start_s"],
        "end_s": s["end_s"],
        "duration_s": round(s["end_s"] - s["start_s"], 2),
        "title": s["title"],
        "hook": s["hook"],
        "score": s["score"],
        "reason": s["reason"],
        "status": s["status"],
        "clip_id": s.get("clip_id"),
        "created_at": s["created_at"].isoformat(),
    }


@router.get("/videos/{video_id}/suggestions")
async def list_suggestions(video_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    last = await db.suggestions.find_one(
        {"video_id": video_id, "user_id": user.id}, sort=[("created_at", -1)]
    )
    if last is None:
        return {"items": []}
    items = (
        await db.suggestions.find({"job_id": last["job_id"], "user_id": user.id}).sort("score", -1).to_list()
    )
    return {"items": [_suggestion_out(s) for s in items]}


class AcceptIn(BaseModel):
    title: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    start_s: Annotated[float, Field(ge=0)] | None = None  # a pessoa pode ajustar antes de aceitar
    end_s: Annotated[float, Field(gt=0)] | None = None


@router.post("/suggestions/{suggestion_id}/accept", status_code=status.HTTP_202_ACCEPTED)
async def accept_suggestion(
    suggestion_id: str, body: AcceptIn, user: WsEditor, db: MongoDb
) -> dict[str, Any]:
    s = await db.suggestions.find_one({"_id": suggestion_id, "user_id": user.id})
    if s is None:
        raise _not_found("Sugestão")
    if s["status"] == "accepted":
        raise ApiError(status.HTTP_409_CONFLICT, "already_accepted", "Esta sugestão já virou corte.")
    video = await _video(db, s["video_id"], user.id)
    clip, job = await enqueue_clip(
        db,
        user.id,
        video,
        body.start_s if body.start_s is not None else s["start_s"],
        body.end_s if body.end_s is not None else s["end_s"],
        body.title or s["title"],
        suggestion_id=s["_id"],
    )
    await db.suggestions.update_one(
        {"_id": s["_id"]}, {"$set": {"status": "accepted", "clip_id": clip["_id"]}}
    )
    await _feedback(db, s.get("call_ids") or [], True)
    await record(
        "ai",
        "highlights.accepted",
        f"Sugestão virou corte (nota {s['score']})",
        outcome="success",
        details={"suggestion_id": s["_id"], "clip_id": clip["_id"]},
    )
    return {"clip": _clip_out(clip), "job": jobs.public_job(job)}


@router.post("/suggestions/{suggestion_id}/dismiss")
async def dismiss_suggestion(suggestion_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    result = await db.suggestions.update_one(
        {"_id": suggestion_id, "user_id": user.id, "status": "new"}, {"$set": {"status": "dismissed"}}
    )
    if not result.matched_count:
        raise _not_found("Sugestão")
    return {"ok": True}


# ---------------------------------------------------------------- metadados a partir da fala


class MetadataIn(BaseModel):
    source_kind: Literal["video", "clip"]
    source_id: Annotated[str, Field(min_length=1, max_length=80)]
    platforms: Annotated[list[Platform], Field(max_length=4)] = ["tiktok", "instagram"]
    tone: Tone = "viral"
    context: Annotated[str, Field(max_length=1000)] = ""


@router.post("/ai/metadata")
async def generate_metadata(body: MetadataIn, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    """Título, descrição, hashtags e chamada para ação a partir do que é falado no vídeo ou corte."""
    await hit(db, "ai:user", user.id, limit=60, window_seconds=3600)
    if body.source_kind == "video":
        source = await _video(db, body.source_id, user.id)
        video_id, start, end = source["_id"], 0.0, float(source["duration_s"])
    else:
        source = await _clip(db, body.source_id, user.id)
        video_id, start, end = source["video_id"], source["start_s"], source["end_s"]
    transcript = await db.transcripts.find_one({"_id": video_id, "status": "ready"})
    text = transcription.text_between(transcript, start, end) if transcript else ""
    conf = await ai_config.load(db)
    if not ai_config.available_models(conf, "metadata"):
        raise ApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE, "ai_unavailable", "A IA não está configurada no servidor."
        )
    amount = await credits.reserve(db, user.id, int(conf["credit_costs"]["metadata"]), "metadados")
    try:
        result = await tasks.metadata(
            db,
            user.id,
            title=source["title"],
            duration_s=end - start,
            transcript_text=text,
            platforms=list(body.platforms),
            tone=body.tone,
            context=body.context,
            ref={body.source_kind + "_id": body.source_id},
        )
    except Exception:
        await credits.refund(db, user.id, amount)
        raise
    return {"metadata": result, "credits": await credits.usage(db, user.id)}


class FeedbackIn(BaseModel):
    accepted: bool


async def _feedback(db: MongoDb, call_ids: list[str], accepted: bool) -> None:
    if call_ids:
        await db.ai_calls.update_many({"_id": {"$in": call_ids}}, {"$set": {"feedback": accepted}})


@router.post("/ai/calls/{call_id}/feedback")
async def call_feedback(call_id: str, body: FeedbackIn, user: WsUser, db: MongoDb) -> dict[str, Any]:
    """A pessoa usou (ou não) o que a IA gerou: é a nota da versão do prompt no teste A/B."""
    result = await db.ai_calls.update_one(
        {"_id": call_id, "user_id": user.id}, {"$set": {"feedback": body.accepted}}
    )
    if not result.matched_count:
        raise _not_found("Chamada")
    return {"ok": True}


@router.get("/ai/usage")
async def ai_usage(user: WsUser, db: MongoDb) -> dict[str, Any]:
    conf = await ai_config.load(db)
    return {"credits": await credits.usage(db, user.id), "costs": conf["credit_costs"]}


# ---------------------------------------------------------------- admin da IA


class TaskConf(BaseModel):
    models: Annotated[
        list[Annotated[str, Field(pattern=r"^(gemini|anthropic|openai|local):[\w.:-]+$")]],
        Field(min_length=1, max_length=6),
    ]
    temperature: Annotated[float, Field(ge=0, le=2)] = 0.5


class Price(BaseModel):
    input_per_mtok: Annotated[float, Field(ge=0)] | None = None
    output_per_mtok: Annotated[float, Field(ge=0)] | None = None
    per_minute: Annotated[float, Field(ge=0)] | None = None


class AISettingsIn(BaseModel):
    tasks: dict[Literal["metadata", "highlights", "ideas", "script", "script_edit"], TaskConf] | None = None
    prices: dict[Annotated[str, Field(max_length=80)], Price] | None = None
    credit_costs: (
        dict[
            Literal[
                "metadata",
                "highlights",
                "transcription_per_minute",
                "subtitles_burn",
                "ideas",
                "script",
                "script_edit",
            ],
            Annotated[int, Field(ge=0, le=1000)],
        ]
        | None
    ) = None
    daily_budget_usd: Annotated[float, Field(ge=0)] | None = None


def _mask(value: str | None) -> str | None:
    if not value:
        return None
    return value if value.startswith("http") else f"…{value[-4:]}"


def _settings_out(conf: dict[str, Any]) -> dict[str, Any]:
    """Configuração para a tela do admin. As chaves saem mascaradas (só os 4 últimos caracteres)."""
    return {
        **{k: v for k, v in conf.items() if k != "keys"},
        "providers": {
            p: {
                "ready": ai_config.provider_ready(p, conf),
                "source": ai_config.key_source(p, conf),
                "key": _mask(ai_config.key_for(p, conf)),
            }
            for p in ai_config.PROVIDERS
        },
        "transcription": {"configured": transcription.configured()},
    }


class KeysIn(BaseModel):
    # Valor vazio ("") apaga a chave do admin e volta a valer a do .env.
    gemini: Annotated[str, Field(max_length=300)] | None = None
    anthropic: Annotated[str, Field(max_length=300)] | None = None
    openai: Annotated[str, Field(max_length=300)] | None = None
    local: Annotated[str, Field(pattern=r"^(https?://\S+)?$", max_length=300)] | None = None


@router.put("/admin/ai/keys")
async def admin_put_ai_keys(body: KeysIn, user: Requires("ai:manage"), db: MongoDb) -> dict[str, Any]:
    """Chaves dos provedores pelo admin, guardadas criptografadas. Nunca voltam inteiras na resposta."""
    sets: dict[str, Any] = {}
    unsets: dict[str, str] = {}
    for provider, value in body.model_dump(exclude_none=True).items():
        if value.strip():
            sets[f"keys.{provider}"] = crypto.encrypt({"key": value.strip()})
        else:
            unsets[f"keys.{provider}"] = ""
    update: dict[str, Any] = {}
    if sets:
        update["$set"] = sets
    if unsets:
        update["$unset"] = unsets
    if update:
        await db.ai_settings.update_one({"_id": "default"}, update, upsert=True)
        ai_config.invalidate()
        await audit(
            "ai.keys_updated",
            details={
                "set": sorted(k.split(".")[1] for k in sets),
                "removed": sorted(k.split(".")[1] for k in unsets),
            },
        )
    return {"settings": _settings_out(await ai_config.load(db))}


@router.get("/admin/ai/settings")
async def admin_ai_settings(user: Requires("ai:manage"), db: MongoDb) -> dict[str, Any]:
    conf = await ai_config.load(db)
    return {"settings": _settings_out(conf), "spent_today_usd": await credits.spent_today(db)}


@router.put("/admin/ai/settings")
async def admin_put_ai_settings(
    body: AISettingsIn, user: Requires("ai:manage"), db: MongoDb
) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    if body.tasks is not None:
        changes.update({f"tasks.{k}": v.model_dump() for k, v in body.tasks.items()})
    if body.prices is not None:
        changes.update({f"prices.{k}": v.model_dump(exclude_none=True) for k, v in body.prices.items()})
    if body.credit_costs is not None:
        changes.update({f"credit_costs.{k}": v for k, v in body.credit_costs.items()})
    if body.daily_budget_usd is not None:
        changes["daily_budget_usd"] = body.daily_budget_usd
    if changes:
        await db.ai_settings.update_one({"_id": "default"}, {"$set": changes}, upsert=True)
        ai_config.invalidate()
        await audit("ai.settings_updated", details={"changes": list(changes)})
    return {"settings": _settings_out(await ai_config.load(db))}


class PromptIn(BaseModel):
    task: Literal["metadata", "highlights", "ideas", "script", "script_edit"]
    system: Annotated[str, Field(min_length=10, max_length=8000)]
    template: Annotated[str, Field(min_length=10, max_length=20000)]
    weight: Annotated[int, Field(ge=0, le=100)] = 50
    active: bool = True
    note: Annotated[str, Field(max_length=300)] = ""


def _prompt_out(p: dict[str, Any]) -> dict[str, Any]:
    return {
        **{k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in p.items() if k != "_id"},
        "id": p["_id"],
    }


@router.get("/admin/ai/prompts")
async def admin_list_prompts(user: Requires("ai:manage"), db: MongoDb) -> dict[str, Any]:
    items = await db.ai_prompts.find({}).sort([("task", 1), ("version", 1)]).to_list()
    return {
        "items": [_prompt_out(p) for p in items],
        "variables": {
            t: sorted({w[1:] for w in p["template"].split() if w.startswith("$")})
            for t, p in DEFAULT_PROMPTS.items()
        },
    }


@router.post("/admin/ai/prompts", status_code=status.HTTP_201_CREATED)
async def admin_new_prompt(body: PromptIn, user: Requires("ai:manage"), db: MongoDb) -> dict[str, Any]:
    """Nova versão do prompt. Ativa junto com as outras, divide as chamadas pelo peso (teste A/B)."""
    last = await db.ai_prompts.find_one({"task": body.task}, sort=[("version", -1)])
    version = (last or {}).get("version", 0) + 1
    doc = {
        **body.model_dump(),
        "_id": f"{body.task}:v{version}",
        "version": version,
        "created_at": datetime.now(UTC),
        "created_by": user.id,
    }
    await db.ai_prompts.insert_one(doc)
    await audit("ai.prompt_created", details={"prompt": doc["_id"], "weight": body.weight})
    return {"prompt": _prompt_out(doc)}


class PromptPatch(BaseModel):
    weight: Annotated[int, Field(ge=0, le=100)] | None = None
    active: bool | None = None


@router.patch("/admin/ai/prompts/{prompt_id}")
async def admin_patch_prompt(
    prompt_id: str, body: PromptPatch, user: Requires("ai:manage"), db: MongoDb
) -> dict[str, Any]:
    changes = body.model_dump(exclude_none=True)
    doc = await db.ai_prompts.find_one_and_update(
        {"_id": prompt_id}, {"$set": changes}, return_document=ReturnDocument.AFTER
    )
    if doc is None:
        raise _not_found("Prompt")
    await audit("ai.prompt_updated", details={"prompt": prompt_id, **changes})
    return {"prompt": _prompt_out(doc)}


@router.get("/admin/ai/stats")
async def admin_ai_stats(
    user: Requires("ai:manage"), db: MongoDb, days: Annotated[int, Query(ge=1, le=90)] = 30
) -> dict[str, Any]:
    """Por tarefa, versão do prompt e modelo: chamadas, custo, tempo médio e taxa de aceitação."""
    since = datetime.now(UTC) - timedelta(days=days)
    rows = await (
        await db.ai_calls.aggregate(
            [
                {"$match": {"created_at": {"$gte": since}}},
                {
                    "$group": {
                        "_id": {
                            "task": "$task",
                            "prompt": "$prompt_id",
                            "provider": "$provider",
                            "model": "$model",
                            "status": "$status",
                        },
                        "calls": {"$sum": 1},
                        "cost_usd": {"$sum": {"$ifNull": ["$cost_usd", 0]}},
                        "unpriced": {"$sum": {"$cond": [{"$eq": ["$cost_usd", None]}, 1, 0]}},
                        "avg_ms": {"$avg": "$ms"},
                        "accepted": {"$sum": {"$cond": [{"$eq": ["$feedback", True]}, 1, 0]}},
                        "rejected": {"$sum": {"$cond": [{"$eq": ["$feedback", False]}, 1, 0]}},
                    }
                },
                {"$sort": {"_id.task": 1, "_id.prompt": 1}},
            ]
        )
    ).to_list()
    items = []
    for r in rows:
        rated = r["accepted"] + r["rejected"]
        items.append(
            {
                **r["_id"],
                "calls": r["calls"],
                "cost_usd": round(r["cost_usd"], 6),
                "unpriced": r["unpriced"],
                "avg_ms": round(r["avg_ms"] or 0),
                "acceptance": round(r["accepted"] / rated, 3) if rated else None,
            }
        )
    return {"days": days, "items": items, "spent_today_usd": await credits.spent_today(db)}

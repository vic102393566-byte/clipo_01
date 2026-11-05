"""API v1 das configurações: preferências, saúde do sistema, segurança da conta e webhooks de saída."""

import asyncio
import contextlib
import secrets
import time
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, status
from pydantic import BaseModel, Field, HttpUrl, field_validator

from clipo_api.core.auth import AuthUser
from clipo_api.core.errors import ApiError
from clipo_api.core.ratelimit import hit
from clipo_api.core.workspace import WsEditor, WsOwner, WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.services import crypto, media, storage, webhooks
from clipo_api.services import settings as settings_service
from clipo_api.services.ai import config as ai_config
from clipo_api.services.ai import credits

router = APIRouter(prefix="/api/v1", tags=["configurações"])

Provider = Literal["auto", "gemini", "anthropic", "openai", "local"]
Corner = Literal["top-left", "top-right", "bottom-left", "bottom-right"]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


# ---------------------------------------------------------------- preferências


@router.get("/settings")
async def get_settings_all(user: AuthUser, ws: WsUser, db: MongoDb) -> dict[str, Any]:
    me = await db.users.find_one({"_id": user.id}, projection={"prefs": 1})
    return {
        "workspace": await settings_service.workspace(db, ws.id),
        "me": settings_service.user_prefs(me or {}),
        "role": ws.ws_role,
        "can_edit_workspace": ws.is_owner,
    }


class WatermarkIn(BaseModel):
    enabled: bool | None = None
    text: Annotated[str | None, Field(max_length=40)] = None
    opacity: Annotated[int | None, Field(ge=5, le=100)] = None
    position: Corner | None = None


class ExportIn(BaseModel):
    max_height: Literal[0, 720, 1080, 1440, 2160] | None = None
    fps: Literal[0, 24, 30, 60] | None = None
    quality: Literal["small", "balanced", "high"] | None = None


class WorkspaceSettingsIn(BaseModel):
    class Automation(BaseModel):
        enabled: bool | None = None

    class AI(BaseModel):
        provider: Provider | None = None
        creativity: Annotated[float | None, Field(ge=0, le=1)] = None
        filter_profanity: bool | None = None

    class Render(BaseModel):
        watermark: WatermarkIn | None = None
        night_queue: bool | None = None
        export: ExportIn | None = None

    class Privacy(BaseModel):
        trash_days: Literal[7, 15, 30, 60] | None = None

    automation: Automation | None = None
    ai: AI | None = None
    render: Render | None = None
    privacy: Privacy | None = None


@router.patch("/settings/workspace")
async def update_workspace_settings(body: WorkspaceSettingsIn, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    changes = body.model_dump(exclude_none=True)
    result = await settings_service.update_workspace(db, ws.id, changes)
    await record("workspace", "settings.updated", "Preferências do workspace alteradas", details=changes)
    if "automation" in changes:
        state = "ligada" if changes["automation"].get("enabled") else "pausada"
        await audit(
            "workspace.automation", actor_id=ws.actor_id, details={"workspace_id": ws.id, "state": state}
        )
    return {"workspace": result}


class MyPrefsIn(BaseModel):
    theme_preset: Annotated[str | None, Field(max_length=30)] = None
    waveform: bool | None = None
    timeline_snap: bool | None = None
    glow: Literal["low", "medium", "high"] | None = None
    strict_ip: bool | None = None
    timezone: Annotated[str | None, Field(max_length=64)] = None

    @field_validator("timezone")
    @classmethod
    def _tz(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise ValueError("Fuso horário desconhecido.") from exc
        return value


@router.patch("/settings/me")
async def update_my_prefs(body: MyPrefsIn, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    changes = {f"prefs.{k}": v for k, v in body.model_dump(exclude_none=True).items()}
    if changes:
        await db.users.update_one({"_id": user.id}, {"$set": changes})
    if body.strict_ip is not None:
        await audit("account.strict_ip", actor_id=user.id, details={"enabled": body.strict_ip})
    me = await db.users.find_one({"_id": user.id}, projection={"prefs": 1})
    return {"me": settings_service.user_prefs(me or {})}


# ---------------------------------------------------------------- IA


@router.get("/settings/ai/check")
async def ai_check(ws: WsUser, db: MongoDb) -> dict[str, Any]:
    """Quais provedores estão prontos no servidor e quanto crédito o workspace ainda tem."""
    conf = await ai_config.load(db)
    providers = [{"id": p, "ready": ai_config.provider_ready(p, conf)} for p in ai_config.PROVIDERS]
    tasks = {
        task: [f"{p}:{m}" for p, m in ai_config.available_models(conf, task)] for task in ai_config.TASKS
    }
    from clipo_api.core.config import get_settings

    s = get_settings()
    return {
        "providers": providers,
        "tasks": tasks,
        "transcription": {"provider": s.stt_provider, "model": s.local_whisper_model},
        "subtitles_burn": await media.can_burn_subtitles(),
        "credits": await credits.usage(db, ws.id),
    }


# ---------------------------------------------------------------- sistema


async def _timed(coro: Any) -> tuple[str, int | None, str | None]:
    started = time.perf_counter()
    try:
        await asyncio.wait_for(coro, 5)
        return "online", round((time.perf_counter() - started) * 1000), None
    except Exception as exc:  # o painel mostra o erro, não derruba
        return "offline", None, type(exc).__name__


@router.get("/system/status")
async def system_status(ws: WsUser, db: MongoDb) -> dict[str, Any]:
    """Serviços que o Clipo usa e a fila deste workspace. Detalhes de infraestrutura ficam no admin."""
    mongo = await _timed(db.command("ping"))
    s3 = await _timed(storage.object_size("healthcheck/ping"))
    worker = await db.worker_status.find_one({}, sort=[("seen_at", -1)])
    seen = worker["seen_at"].replace(tzinfo=UTC) if worker else None
    worker_state = "online" if seen and _now() - seen < timedelta(minutes=3) else "offline"
    queued = await db.jobs.count_documents({"user_id": ws.id, "status": "queued"})
    running = await db.jobs.count_documents({"user_id": ws.id, "status": "running"})
    failed_24h = await db.jobs.count_documents(
        {"user_id": ws.id, "status": "failed", "finished_at": {"$gte": _now() - timedelta(hours=24)}}
    )
    return {
        "services": [
            {"id": "api", "name": "API", "status": "online", "latency_ms": 0},
            {"id": "database", "name": "Banco de dados", "status": mongo[0], "latency_ms": mongo[1]},
            {"id": "storage", "name": "Armazenamento de arquivos", "status": s3[0], "latency_ms": s3[1]},
            {"id": "worker", "name": "Processamento (worker)", "status": worker_state, "seen_at": _iso(seen)},
            {
                "id": "ffmpeg",
                "name": "FFmpeg",
                "status": "online" if media.ffmpeg_bin() else "offline",
                "subtitles": await media.can_burn_subtitles(),
            },
        ],
        "queue": {"queued": queued, "running": running, "failed_24h": failed_24h},
    }


@router.post("/system/cleanup")
async def cleanup(ws: WsEditor, db: MongoDb) -> dict[str, Any]:
    """Cancela envios parados há mais de 24 h e apaga as partes que ficaram no armazenamento."""
    cutoff = _now() - timedelta(hours=24)
    removed, freed = 0, 0
    async for up in db.uploads.find({"user_id": ws.id, "status": "uploading", "created_at": {"$lt": cutoff}}):
        # A parte pode já ter expirado no S3: segue a limpeza do mesmo jeito.
        with contextlib.suppress(Exception):
            await storage.abort_multipart(up["key"], up["s3_upload_id"])
        await db.uploads.update_one({"_id": up["_id"]}, {"$set": {"status": "aborted"}})
        removed += 1
        freed += up.get("size_bytes", 0)
    await record("system", "cleanup.done", f"Limpeza: {removed} envio(s) parado(s) cancelado(s)")
    return {"aborted_uploads": removed, "freed_bytes": freed}


# ---------------------------------------------------------------- segurança da conta


@router.get("/account/activity")
async def account_activity(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    """Ações sensíveis da conta (login, troca de senha, sessões, equipe), do mais novo ao mais antigo."""
    rows = (
        await db.system_logs.find(
            {"user_id": user.id, "category": {"$in": ["auth", "workspace"]}},
            projection={"event": 1, "message": 1, "level": 1, "outcome": 1, "created_at": 1, "details.ip": 1},
        )
        .sort("created_at", -1)
        .limit(50)
        .to_list()
    )
    return {
        "items": [
            {
                "id": r["_id"],
                "event": r.get("event"),
                "message": r.get("message"),
                "level": r.get("level"),
                "outcome": r.get("outcome"),
                "ip": (r.get("details") or {}).get("ip"),
                "at": _iso(r["created_at"]),
            }
            for r in rows
        ]
    }


@router.get("/account/security-check")
async def security_check(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    """Checagem rápida: o que está bom e o que dá para melhorar na segurança da conta."""
    me = await db.users.find_one({"_id": user.id}) or {}
    sessions = await db.sessions.distinct(
        "family_id", {"user_id": user.id, "revoked_at": None, "expires_at": {"$gt": _now()}}
    )
    expiring = await db.connections.count_documents(
        {
            "user_id": user.id,
            "$or": [
                {"status": "needs_reconnect"},
                {"access_expires_at": {"$lt": _now() + timedelta(days=3)}},
            ],
        }
    )
    prefs = settings_service.user_prefs(me)
    checks = [
        {
            "id": "email",
            "ok": me.get("email_verified_at") is not None,
            "label": "E-mail confirmado",
        },
        {
            "id": "login",
            "ok": bool(me.get("password_hash")) or bool(me.get("identities")),
            "label": "Forma de entrar configurada (senha ou Google/Apple)",
        },
        {
            "id": "sessions",
            "ok": len(sessions) <= 3,
            "label": f"{len(sessions)} sessão(ões) aberta(s)",
            "hint": "Encerre as que você não reconhece." if len(sessions) > 3 else None,
        },
        {
            "id": "connections",
            "ok": expiring == 0,
            "label": "Redes sociais com acesso em dia"
            if expiring == 0
            else f"{expiring} rede(s) para reconectar",
        },
        {"id": "strict_ip", "ok": prefs["strict_ip"], "label": "IP estrito", "optional": True},
    ]
    required = [c for c in checks if not c.get("optional")]
    score = round(sum(c["ok"] for c in required) / len(required) * 100)
    await record("auth", "security.check", f"Checagem de segurança: {score}%", details={"score": score})
    return {"score": score, "checks": checks}


# ---------------------------------------------------------------- webhooks de saída


def _admin_only(ws: Any) -> None:
    """Webhooks e automações do servidor ficam no painel do administrador."""
    if ws.role not in ("admin", "super_admin"):
        raise ApiError(
            status.HTTP_403_FORBIDDEN, "forbidden", "Webhooks são configurados pela equipe do Clipo."
        )


def public_webhook(doc: dict[str, Any]) -> dict[str, Any]:
    ok, bad = doc.get("success_count", 0), doc.get("failure_count", 0)
    return {
        "id": doc["_id"],
        "name": doc["name"],
        "url": doc["url"],
        "events": doc["events"],
        "active": doc["active"],
        "last_triggered_at": _iso(doc.get("last_triggered_at")),
        "last_status": doc.get("last_status"),
        "last_error": doc.get("last_error"),
        "success_rate": round(ok / (ok + bad) * 100, 1) if ok + bad else None,
        "deliveries": ok + bad,
        "created_at": _iso(doc["created_at"]),
    }


async def _hook(db: MongoDb, hook_id: str, user_id: str) -> dict[str, Any]:
    doc = await db.webhooks.find_one({"_id": hook_id, "user_id": user_id})
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Webhook não encontrado.")
    return doc


@router.get("/webhooks")
async def list_webhooks(ws: WsUser, db: MongoDb) -> dict[str, Any]:
    _admin_only(ws)
    docs = await db.webhooks.find({"user_id": ws.id}).sort("created_at", 1).to_list()
    return {
        "items": [public_webhook(d) for d in docs],
        "events": [{"id": k, "label": v} for k, v in webhooks.EVENTS.items()],
    }


EventName = Literal[
    "*",
    "publication.published",
    "publication.failed",
    "video.ready",
    "clips.ready",
    "clip.ready",
    "transcript.ready",
    "subtitles.ready",
]


class WebhookIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=60)]
    url: HttpUrl
    events: Annotated[list[EventName], Field(min_length=1, max_length=10)]


@router.post("/webhooks", status_code=status.HTTP_201_CREATED)
async def create_webhook(body: WebhookIn, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    _admin_only(ws)
    if await db.webhooks.count_documents({"user_id": ws.id}) >= 10:
        raise ApiError(status.HTTP_409_CONFLICT, "webhook_limit", "Cada workspace pode ter até 10 webhooks.")
    try:
        await webhooks.check_url(str(body.url))
    except webhooks.UnsafeUrl as exc:
        raise ApiError(status.HTTP_422_UNPROCESSABLE_ENTITY, "unsafe_url", str(exc)) from exc
    secret = "whsec_" + secrets.token_urlsafe(24)
    doc = {
        "_id": uuid4().hex,
        "user_id": ws.id,
        "created_by": ws.actor_id,
        "name": body.name.strip(),
        "url": str(body.url),
        "events": sorted(set(body.events)),
        "active": True,
        "secret": crypto.encrypt({"secret": secret}),
        "success_count": 0,
        "failure_count": 0,
        "created_at": _now(),
    }
    await db.webhooks.insert_one(doc)
    await audit("webhook.created", actor_id=ws.actor_id, details={"workspace_id": ws.id, "url": doc["url"]})
    # O segredo aparece só agora; depois, só girando.
    return {"webhook": public_webhook(doc), "secret": secret}


class WebhookPatch(BaseModel):
    name: Annotated[str | None, Field(min_length=1, max_length=60)] = None
    url: HttpUrl | None = None
    events: Annotated[list[EventName] | None, Field(min_length=1, max_length=10)] = None
    active: bool | None = None


@router.patch("/webhooks/{hook_id}")
async def edit_webhook(hook_id: str, body: WebhookPatch, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    _admin_only(ws)
    await _hook(db, hook_id, ws.id)
    changes = body.model_dump(exclude_none=True)
    if "url" in changes:
        changes["url"] = str(changes["url"])
        try:
            await webhooks.check_url(changes["url"])
        except webhooks.UnsafeUrl as exc:
            raise ApiError(status.HTTP_422_UNPROCESSABLE_ENTITY, "unsafe_url", str(exc)) from exc
    if "events" in changes:
        changes["events"] = sorted(set(changes["events"]))
    doc = await db.webhooks.find_one_and_update({"_id": hook_id}, {"$set": changes}, return_document=True)
    return {"webhook": public_webhook(doc)}


@router.post("/webhooks/{hook_id}/rotate-secret")
async def rotate_secret(hook_id: str, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    _admin_only(ws)
    await _hook(db, hook_id, ws.id)
    secret = "whsec_" + secrets.token_urlsafe(24)
    await db.webhooks.update_one({"_id": hook_id}, {"$set": {"secret": crypto.encrypt({"secret": secret})}})
    await audit("webhook.secret_rotated", actor_id=ws.actor_id, details={"webhook_id": hook_id})
    return {"secret": secret}


@router.post("/webhooks/{hook_id}/test", status_code=status.HTTP_202_ACCEPTED)
async def test_webhook(hook_id: str, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    _admin_only(ws)
    await hit(db, "webhook-test:user", ws.id, limit=20, window_seconds=600)
    hook = await _hook(db, hook_id, ws.id)
    if not hook["active"]:
        raise ApiError(status.HTTP_409_CONFLICT, "webhook_paused", "Ative o webhook antes de testar.")
    delivery_id = await webhooks.queue(
        db, ws.id, hook_id, "ping", {"message": "Teste do Clipo", "webhook": hook["name"]}
    )
    return {"delivery_id": delivery_id}


@router.get("/webhooks/{hook_id}/deliveries")
async def list_deliveries(hook_id: str, ws: WsUser, db: MongoDb) -> dict[str, Any]:
    _admin_only(ws)
    await _hook(db, hook_id, ws.id)
    docs = (
        await db.webhook_deliveries.find({"webhook_id": hook_id}).sort("created_at", -1).limit(30).to_list()
    )
    return {
        "items": [
            {
                "id": d["_id"],
                "event": d["event"],
                "status": d["status"],
                "status_code": d.get("status_code"),
                "error": d.get("error"),
                "attempts": d.get("attempts", 0),
                "ms": d.get("ms"),
                "created_at": _iso(d["created_at"]),
            }
            for d in docs
        ]
    }


@router.delete("/webhooks/{hook_id}")
async def delete_webhook(hook_id: str, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    _admin_only(ws)
    await _hook(db, hook_id, ws.id)
    await db.webhooks.delete_one({"_id": hook_id})
    await db.webhook_deliveries.delete_many({"webhook_id": hook_id})
    await audit("webhook.deleted", actor_id=ws.actor_id, details={"webhook_id": hook_id})
    return {"ok": True}

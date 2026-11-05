"""API v1 das redes sociais: conectar, desconectar, renovar, botão de testes e webhooks das redes."""

import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from urllib.parse import urlencode

from fastapi import APIRouter, Query, Request, status
from fastapi.responses import PlainTextResponse, RedirectResponse
from pydantic import BaseModel
from pymongo.errors import DuplicateKeyError

from clipo_api.core.auth import current_user
from clipo_api.core.config import get_settings
from clipo_api.core.errors import ApiError
from clipo_api.core.ratelimit import client_ip, hit
from clipo_api.core.workspace import WsOwner, WsPublisher, WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.services import connections, connectors, crypto, diagnostics, jobs, publications
from clipo_api.services.connectors import instagram as ig_module
from clipo_api.services.connectors import tiktok as tt_module
from clipo_api.services.connectors.base import ConnectorError
from clipo_api.services.oidc import pkce_pair

router = APIRouter(prefix="/api/v1", tags=["redes sociais"])

BINDING_COOKIE = "clipo_connect"
BINDING_PATH = "/api/v1/connections"
STATE_TTL = timedelta(minutes=10)


def _connector(platform: str):
    connector = connectors.get(platform)
    if connector is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Rede social não suportada.")
    return connector


def _redirect_uri(platform: str) -> str:
    return f"{get_settings().app_base_url}/api/v1/connections/{platform}/callback"


def _back_to_app(**params: str) -> RedirectResponse:
    response = RedirectResponse(f"{get_settings().app_base_url}/contas?{urlencode(params)}", 303)
    response.delete_cookie(BINDING_COOKIE, path=BINDING_PATH)
    return response


@router.get("/connections")
async def list_connections(user: WsUser, db: MongoDb) -> dict[str, Any]:
    docs = {d["platform"]: d async for d in db.connections.find({"user_id": user.id})}
    last = {}
    async for d in db.diagnostics.find({"user_id": user.id}).sort("created_at", -1).limit(50):
        last.setdefault(d["target"], diagnostics.public_diagnostic(d))
    return {
        "items": [
            {**connections.public_connection(p, docs.get(p)), "last_diagnostic": last.get(p)}
            for p in connectors.CONNECTORS
        ],
        "payments_last_diagnostic": last.get("payments"),
    }


@router.get("/connections/{platform}/connect")
async def connect(platform: str, user: WsOwner, db: MongoDb, request: Request) -> RedirectResponse:
    connector = _connector(platform)
    if not connector.configured():
        await record(
            "integration",
            "connect.not_configured",
            f"{connector.label} sem credenciais do app",
            level="warning",
            platform=platform,
        )
        return _back_to_app(connection_error="not_configured", platform=platform)
    await hit(db, "connect:user", user.id, limit=20, window_seconds=600)
    if not await connections.within_plan(db, user.id, platform):
        await record(
            "integration",
            "connect.plan_limit",
            f"Limite de contas sociais do plano ao conectar o {connector.label}",
            level="warning",
            outcome="denied",
            platform=platform,
        )
        return _back_to_app(connection_error="plan_limit", platform=platform)
    state = secrets.token_urlsafe(32)
    binding = secrets.token_urlsafe(24)
    verifier, challenge = pkce_pair()
    now = datetime.now(UTC)
    await db.oauth_states.insert_one(
        {
            "_id": hashlib.sha256(state.encode()).hexdigest(),
            "kind": "connection",
            "provider": platform,
            "user_id": user.id,
            "verifier": verifier if platform == "youtube" else None,
            "binding": hashlib.sha256(binding.encode()).hexdigest(),
            "created_at": now,
            "expires_at": now + STATE_TTL,
        }
    )
    url = connector.authorize_url(
        state, _redirect_uri(platform), challenge if platform == "youtube" else None
    )
    response = RedirectResponse(url, 303)
    response.set_cookie(
        BINDING_COOKIE,
        binding,
        max_age=int(STATE_TTL.total_seconds()),
        httponly=True,
        secure=get_settings().cookie_secure,
        samesite="lax",
        path=BINDING_PATH,
    )
    return response


@router.get("/connections/{platform}/callback", include_in_schema=False)
async def callback(
    platform: str,
    request: Request,
    db: MongoDb,
    code: Annotated[str | None, Query(max_length=2000)] = None,
    state: Annotated[str | None, Query(max_length=200)] = None,
    error: Annotated[str | None, Query(max_length=200)] = None,
) -> RedirectResponse:
    connector = _connector(platform)

    async def fail(code_: str, reason: str) -> RedirectResponse:
        await record(
            "integration",
            "connect.failed",
            f"Falha ao conectar {connector.label}: {reason}",
            level="warning",
            outcome="failure",
            platform=platform,
            details={"error_code": code_},
        )
        return _back_to_app(connection_error=code_, platform=platform)

    if error:
        return await fail(
            "cancelled" if error in ("access_denied", "user_denied") else "provider_error", error
        )
    doc = await db.oauth_states.find_one_and_delete(
        {"_id": hashlib.sha256((state or "").encode()).hexdigest()}
    )
    if not code or doc is None or doc.get("kind") != "connection" or doc["provider"] != platform:
        return await fail("expired", "state desconhecido, já usado ou vencido")
    if doc["expires_at"] < datetime.now(UTC):
        return await fail("expired", "state vencido")
    binding = request.cookies.get(BINDING_COOKIE, "")
    if not binding or not secrets.compare_digest(
        doc["binding"], hashlib.sha256(binding.encode()).hexdigest()
    ):
        return await fail("expired", "o retorno não veio do navegador que começou a conexão")
    try:
        user = await current_user(request, db)
    except ApiError:
        return await fail("session_expired", "a sessão do Clipo terminou durante a conexão")
    if user.id != doc["user_id"]:
        return await fail("expired", "a conexão foi iniciada por outra conta")

    try:
        tokens = await connector.exchange_code(code, _redirect_uri(platform), doc.get("verifier"))
        account = await connector.account(tokens.secrets())
        await connections.save(db, user.id, platform, tokens, account)
    except ConnectorError as exc:
        return await fail(exc.code, exc.message)
    except crypto.TokenKeyMissing:
        return await fail("server_misconfigured", "TOKEN_ENCRYPTION_KEY ausente")
    await record(
        "integration",
        "connect.success",
        f"{connector.label} conectado: {account.handle}",
        outcome="success",
        user_id=user.id,
        platform=platform,
        details={"account_id": account.id},
    )
    await audit(
        "connection.created",
        target_user_id=user.id,
        details={"platform": platform, "account": account.handle},
    )
    return _back_to_app(connected=platform)


@router.delete("/connections/{platform}")
async def disconnect(platform: str, user: WsOwner, db: MongoDb) -> dict[str, Any]:
    connector = _connector(platform)
    conn = await db.connections.find_one({"_id": connections.connection_id(user.id, platform)})
    if conn:
        try:
            await connector.revoke(crypto.decrypt(conn["tokens"]))
        except Exception:  # sem acesso à rede, a conexão sai do Clipo do mesmo jeito
            await record(
                "integration",
                "revoke.failed",
                f"Não deu para revogar o acesso no {connector.label}",
                level="warning",
                platform=platform,
            )
        await db.connections.delete_one({"_id": conn["_id"]})
        await record("integration", "disconnected", f"{connector.label} desconectado", platform=platform)
        await audit("connection.removed", target_user_id=user.id, details={"platform": platform})
    return {"message": f"{connector.label} desconectado."}


@router.post("/connections/{platform}/refresh")
async def force_refresh(platform: str, user: WsOwner, db: MongoDb) -> dict[str, Any]:
    _connector(platform)
    conn = await db.connections.find_one({"_id": connections.connection_id(user.id, platform)})
    if conn is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_connected", "Esta rede não está conectada.")
    try:
        await connections.refresh_tokens(db, conn, reason="pedido manual")
    except ConnectorError as exc:
        raise ApiError(status.HTTP_502_BAD_GATEWAY, exc.code, exc.message) from exc
    current = await db.connections.find_one({"_id": conn["_id"]})
    return {"connection": connections.public_connection(platform, current)}


# ---------------------------------------------------------------- botão de testes


class DiagnosticIn(BaseModel):
    target: diagnostics.Target


@router.post("/diagnostics", status_code=status.HTTP_202_ACCEPTED)
async def start_diagnostic(body: DiagnosticIn, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    await hit(db, "diagnostic:user", user.id, limit=10, window_seconds=600)
    running = await db.diagnostics.find_one(
        {"user_id": user.id, "target": body.target, "status": {"$in": ["queued", "running"]}}
    )
    if running:
        raise ApiError(
            status.HTTP_409_CONFLICT, "already_running", "Já existe um teste desta rede em andamento."
        )
    diagnostic, job = await diagnostics.start(db, user.id, body.target)
    await record(
        "integration",
        "diagnostic.started",
        f"Teste de {body.target} iniciado",
        platform=body.target,
        details={"diagnostic_id": diagnostic["_id"]},
    )
    return {"diagnostic": diagnostics.public_diagnostic(diagnostic), "job": jobs.public_job(job)}


@router.get("/diagnostics")
async def list_diagnostics(
    user: WsUser,
    db: MongoDb,
    target: diagnostics.Target | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, Any]:
    query: dict[str, Any] = {"user_id": user.id}
    if target:
        query["target"] = target
    docs = await db.diagnostics.find(query).sort("created_at", -1).limit(limit).to_list()
    return {"items": [diagnostics.public_diagnostic(d) for d in docs]}


@router.get("/diagnostics/{diagnostic_id}")
async def get_diagnostic(diagnostic_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    doc = await db.diagnostics.find_one({"_id": diagnostic_id, "user_id": user.id})
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Teste não encontrado.")
    return {"diagnostic": diagnostics.public_diagnostic(doc)}


# ---------------------------------------------------------------- webhooks das redes


async def _first_time(db: MongoDb, provider: str, event_id: str) -> bool:
    """Cada evento é processado uma vez só, mesmo que a rede mande de novo."""
    try:
        await db.webhook_events.insert_one(
            {
                "_id": f"{provider}:{event_id}",
                "received_at": datetime.now(UTC),
                "expires_at": datetime.now(UTC) + timedelta(days=30),
            }
        )
    except DuplicateKeyError:
        return False
    return True


@router.post("/webhooks/tiktok", include_in_schema=False)
async def tiktok_webhook(request: Request, db: MongoDb) -> dict[str, Any]:
    secret = get_settings().tiktok_client_secret
    body = await request.body()
    if not secret or not tt_module.webhook_signature_valid(
        request.headers.get("tiktok-signature", ""), body, secret
    ):
        await record(
            "webhook",
            "tiktok.rejected",
            "Webhook do TikTok com assinatura inválida",
            level="error",
            outcome="denied",
            platform="tiktok",
            details={"ip": client_ip(request), "bytes": len(body)},
        )
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "invalid_signature", "Assinatura inválida.")
    try:
        event = json.loads(body)
        content = json.loads(event.get("content") or "{}")
    except ValueError as exc:
        raise ApiError(status.HTTP_400_BAD_REQUEST, "invalid_payload", "Corpo inválido.") from exc
    event_id = f"{event.get('event')}:{content.get('publish_id') or ''}:{event.get('create_time')}"
    if not await _first_time(db, "tiktok", event_id):
        return {"received": True, "duplicate": True}
    conn = await db.connections.find_one({"platform": "tiktok", "account.id": event.get("user_openid")})
    linked = await publications.tiktok_event(
        db,
        event.get("event", ""),
        content.get("publish_id"),
        content.get("reason") or content.get("fail_reason"),
    )
    await record(
        "webhook",
        f"tiktok.{event.get('event', 'unknown')}",
        f"Evento do TikTok: {event.get('event')}",
        outcome="success",
        platform="tiktok",
        user_id=conn["user_id"] if conn else None,
        details={"publish_id": content.get("publish_id"), "reason": content.get("reason"), "linked": linked},
    )
    return {"received": True}


@router.get("/webhooks/meta", include_in_schema=False)
async def meta_webhook_verify(request: Request) -> PlainTextResponse:
    """A Meta confirma o endereço do webhook antes de começar a mandar eventos."""
    params = request.query_params
    token = get_settings().meta_webhook_verify_token
    if (
        params.get("hub.mode") == "subscribe"
        and token
        and secrets.compare_digest(params.get("hub.verify_token", ""), token)
    ):
        await record("webhook", "meta.verified", "Webhook da Meta verificado", platform="instagram")
        return PlainTextResponse(params.get("hub.challenge", ""))
    raise ApiError(status.HTTP_403_FORBIDDEN, "forbidden", "Token de verificação inválido.")


@router.post("/webhooks/meta", include_in_schema=False)
async def meta_webhook(request: Request, db: MongoDb) -> dict[str, Any]:
    secret = get_settings().instagram_client_secret
    body = await request.body()
    if not secret or not ig_module.webhook_signature_valid(
        request.headers.get("x-hub-signature-256", ""), body, secret
    ):
        await record(
            "webhook",
            "meta.rejected",
            "Webhook da Meta com assinatura inválida",
            level="error",
            outcome="denied",
            platform="instagram",
            details={"ip": client_ip(request), "bytes": len(body)},
        )
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "invalid_signature", "Assinatura inválida.")
    payload = json.loads(body or b"{}")
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            event_id = f"{entry.get('id')}:{change.get('field')}:{entry.get('time')}"
            if await _first_time(db, "meta", event_id):
                await record(
                    "webhook",
                    f"meta.{change.get('field', 'unknown')}",
                    f"Evento da Meta: {change.get('field')}",
                    outcome="success",
                    platform="instagram",
                    details={"account_id": entry.get("id")},
                )
    return {"received": True}

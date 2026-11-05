"""Rotas de entrar com Google e com Apple.

Fluxo: a tela abre /start → o provedor autentica → volta em /callback (GET no Google, POST na
Apple) → a API confere tudo, encontra ou cria a conta, abre a sessão e redireciona para o app.
Qualquer falha volta para /login?oauth_error=<código>, e o motivo detalhado vai para o log.
"""

import hashlib
import secrets
from datetime import UTC, datetime
from typing import Annotated, Any
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import APIRouter, Form, Query, Request
from fastapi.responses import RedirectResponse
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from clipo_api.core.config import get_settings
from clipo_api.core.errors import ApiError
from clipo_api.core.plans import FREE_PLAN_ID
from clipo_api.core.ratelimit import client_ip, hit
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.services import billing, oidc
from clipo_api.services.sessions import ensure_can_sign_in, open_session

router = APIRouter(prefix="/api/v1/auth", tags=["autenticação · Google e Apple"])

BINDING_COOKIE = "clipo_oidc"
BINDING_PATH = "/api/v1/auth/oauth"


def _safe_next(value: str | None) -> str:
    if not value or not value.startswith("/") or value.startswith(("//", "/\\")) or "\n" in value:
        return "/dashboard"
    return value[:300]


def _to_app(path: str) -> str:
    return f"{get_settings().app_base_url}{path}"


def _to_login_with_error(code: str, provider: str) -> RedirectResponse:
    response = RedirectResponse(
        _to_app(f"/login?{urlencode({'oauth_error': code, 'provider': provider})}"), 303
    )
    response.delete_cookie(BINDING_COOKIE, path=BINDING_PATH)
    return response


@router.get("/providers")
async def providers() -> dict[str, Any]:
    """Quais botões de login social a tela deve mostrar."""
    return {
        name: {"configured": oidc.is_configured(name), "label": p.label} for name, p in oidc.PROVIDERS.items()
    }


@router.get("/oauth/{provider}/start")
async def start(
    provider: str, request: Request, db: MongoDb, next: Annotated[str | None, Query(max_length=300)] = None
) -> RedirectResponse:
    if provider not in oidc.PROVIDERS:
        raise ApiError(404, "not_found", "Provedor de login não suportado.")
    if not oidc.is_configured(provider):
        await record(
            "auth",
            "oauth.not_configured",
            f"Login com {provider} sem credenciais",
            level="warning",
            platform=provider,
        )
        return _to_login_with_error("not_configured", provider)
    await hit(db, "oauth:ip", client_ip(request), limit=30, window_seconds=600)

    binding = secrets.token_urlsafe(24)
    state, doc = oidc.new_state_doc(provider, _safe_next(next), binding)
    await db.oauth_states.insert_one(doc)
    response = RedirectResponse(oidc.authorize_url(provider, state, doc), 303)
    settings = get_settings()
    # A Apple volta por POST vindo do site dela: o cookie precisa de SameSite=None (exige HTTPS).
    cross_site = oidc.PROVIDERS[provider].form_post
    response.set_cookie(
        BINDING_COOKIE,
        binding,
        max_age=int(oidc.STATE_TTL.total_seconds()),
        httponly=True,
        secure=settings.cookie_secure or cross_site,
        samesite="none" if cross_site else "lax",
        path=BINDING_PATH,
    )
    return response


async def _resolve_account(db: AsyncDatabase, identity: oidc.Identity) -> tuple[dict[str, Any], str]:
    """Encontra a conta pela identidade, liga por e-mail confirmado, ou cria. Devolve (conta, como)."""
    now = datetime.now(UTC)
    user = await db.users.find_one(
        {"identities": {"$elemMatch": {"provider": identity.provider, "subject": identity.subject}}}
    )
    if user:
        return user, "existing"

    user = await db.users.find_one({"email": identity.email})
    entry = {
        "provider": identity.provider,
        "subject": identity.subject,
        "email": identity.email,
        "linked_at": now,
    }
    if user:
        # O provedor confirmou que o e-mail é da pessoa: dá para ligar à conta que já existe.
        update: dict[str, Any] = {"$push": {"identities": entry}}
        if user.get("email_verified_at") is None:
            update["$set"] = {"email_verified_at": now}
        await db.users.update_one({"_id": user["_id"]}, update)
        await audit(
            "identity.linked",
            actor_id=user["_id"],
            target_user_id=user["_id"],
            details={"provider": identity.provider, "by": "email"},
        )
        return await db.users.find_one({"_id": user["_id"]}), "linked"

    user = {
        "_id": uuid4().hex,
        "email": identity.email,
        "name": identity.name or identity.email.split("@")[0],
        "password_hash": None,
        "identities": [entry],
        "role": "user",
        "plan_id": FREE_PLAN_ID,
        "status": "active",
        "email_verified_at": now,
        "created_at": now,
        "schema_version": 1,
    }
    try:
        await db.users.insert_one(user)
    except DuplicateKeyError:
        # Dois retornos quase juntos: o outro já criou a conta.
        user = await db.users.find_one({"email": identity.email})
        return user, "existing"
    await billing.on_user_created(db, user["_id"])
    await record(
        "auth",
        "register.created",
        f"Conta criada pelo {identity.provider}: {identity.email}",
        outcome="success",
        user_id=user["_id"],
        platform=identity.provider,
    )
    return user, "created"


async def _finish(
    provider: str,
    request: Request,
    db: MongoDb,
    code: str | None,
    state: str | None,
    error: str | None,
    apple_user: str | None = None,
) -> RedirectResponse:
    if provider not in oidc.PROVIDERS:
        raise ApiError(404, "not_found", "Provedor de login não suportado.")

    async def fail(code_: str, reason: str) -> RedirectResponse:
        await record(
            "auth",
            "oauth.login.failed",
            f"Login com {provider} falhou: {reason}",
            level="warning",
            outcome="failure",
            platform=provider,
            details={"error_code": code_},
        )
        return _to_login_with_error(code_, provider)

    if error:
        return await fail(
            "cancelled" if error == "access_denied" else "provider_error", f"provedor respondeu {error}"
        )
    if not code or not state:
        return await fail("invalid_request", "retorno sem código ou state")

    # O state é de uso único: apagado na mesma operação em que é lido.
    doc = await db.oauth_states.find_one_and_delete({"_id": hashlib.sha256(state.encode()).hexdigest()})
    if doc is None or doc["provider"] != provider or doc["expires_at"] < datetime.now(UTC):
        return await fail("expired", "state desconhecido, já usado ou vencido")
    binding = request.cookies.get(BINDING_COOKIE, "")
    if not binding or not secrets.compare_digest(
        doc["binding"], hashlib.sha256(binding.encode()).hexdigest()
    ):
        return await fail("expired", "o retorno não veio do navegador que começou o login")

    try:
        tokens = await oidc.exchange_code(provider, code, doc.get("verifier"))
        claims = await oidc.verify_id_token(provider, tokens["id_token"], doc["nonce"])
        identity = oidc.identity_from_claims(provider, claims, apple_user)
    except oidc.OidcError as exc:
        return await fail(exc.code, exc.reason)

    user, how = await _resolve_account(db, identity)
    try:
        await ensure_can_sign_in(db, user)
    except ApiError as exc:
        return _to_login_with_error(exc.detail["code"], provider)

    response = RedirectResponse(_to_app(doc["next"]), 303)
    response.delete_cookie(BINDING_COOKIE, path=BINDING_PATH)
    await open_session(db, request, response, user)
    await record(
        "auth",
        "oauth.login.success",
        f"Login com {provider}: {identity.email}",
        outcome="success",
        user_id=user["_id"],
        platform=provider,
        details={"account": how, "ip": client_ip(request)},
    )
    return response


@router.get("/oauth/{provider}/callback", include_in_schema=False)
async def callback_get(
    provider: str,
    request: Request,
    db: MongoDb,
    code: Annotated[str | None, Query(max_length=2000)] = None,
    state: Annotated[str | None, Query(max_length=200)] = None,
    error: Annotated[str | None, Query(max_length=200)] = None,
) -> RedirectResponse:
    return await _finish(provider, request, db, code, state, error)


@router.post("/oauth/{provider}/callback", include_in_schema=False)
async def callback_post(
    provider: str,
    request: Request,
    db: MongoDb,
    code: Annotated[str | None, Form(max_length=2000)] = None,
    state: Annotated[str | None, Form(max_length=200)] = None,
    error: Annotated[str | None, Form(max_length=200)] = None,
    user: Annotated[str | None, Form(max_length=2000)] = None,
) -> RedirectResponse:
    """Retorno da Apple (form_post). `user` traz o nome, só no primeiro login."""
    return await _finish(provider, request, db, code, state, error, apple_user=user)

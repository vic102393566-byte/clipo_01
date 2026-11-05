"""Sessões e tokens de e-mail, usados pelo login com senha, pelo Google, pela Apple e pela conta."""

from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import Request, Response, status
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.config import get_settings
from clipo_api.core.errors import ApiError
from clipo_api.core.middleware import ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE
from clipo_api.core.ratelimit import client_ip
from clipo_api.core.security import create_access_token, hash_token, new_opaque_token

# Caminho "/": a área logada do Next precisa ver o cookie ao abrir uma página para renovar a sessão.
REFRESH_COOKIE_PATH = "/"


def _now() -> datetime:
    return datetime.now(UTC)


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["_id"],
        "email": user["email"],
        "name": user["name"],
        "role": user["role"],
        "plan_id": user["plan_id"],
        "email_verified": user.get("email_verified_at") is not None,
        "has_password": bool(user.get("password_hash")),
        "providers": sorted({i["provider"] for i in user.get("identities", [])}),
        "avatar_url": f"/media/{user['avatar_key']}" if user.get("avatar_key") else None,
        "locale": user.get("locale", "pt-BR"),
        "theme": user.get("theme", "dark"),
        "status": user.get("status", "active"),
    }


# ---------------------------------------------------------------- cookies e sessões


def set_session_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    settings = get_settings()
    common: dict[str, Any] = {"secure": settings.cookie_secure, "samesite": "lax"}
    response.set_cookie(
        ACCESS_COOKIE,
        access_token,
        max_age=settings.access_token_minutes * 60,
        httponly=True,
        path="/",
        **common,
    )
    response.set_cookie(
        REFRESH_COOKIE,
        refresh_token,
        max_age=settings.refresh_token_days * 86400,
        httponly=True,
        path=REFRESH_COOKIE_PATH,
        **common,
    )
    # Lido pelo JavaScript da página para repetir no cabeçalho X-CSRF-Token.
    response.set_cookie(
        CSRF_COOKIE,
        new_opaque_token(),
        max_age=settings.refresh_token_days * 86400,
        httponly=False,
        path="/",
        **common,
    )


def clear_session_cookies(response: Response) -> None:
    settings = get_settings()
    for name, path in (
        (ACCESS_COOKIE, "/"),
        (REFRESH_COOKIE, REFRESH_COOKIE_PATH),
        (CSRF_COOKIE, "/"),
    ):
        response.delete_cookie(name, path=path, secure=settings.cookie_secure, samesite="lax")


async def open_session(
    db: AsyncDatabase,
    request: Request,
    response: Response,
    user: dict[str, Any],
    family_id: str | None = None,
    started_at: datetime | None = None,
) -> None:
    """Abre (ou continua, ao renovar) uma sessão. `family_id` identifica o aparelho."""
    settings = get_settings()
    refresh_token = new_opaque_token()
    family_id = family_id or uuid4().hex
    now = _now()
    await db.sessions.insert_one(
        {
            "_id": uuid4().hex,
            "user_id": user["_id"],
            "family_id": family_id,
            "token_hash": hash_token(refresh_token),
            "created_at": now,
            # Quando este aparelho entrou (mantido a cada renovação).
            "started_at": started_at or now,
            "expires_at": now + timedelta(days=settings.refresh_token_days),
            "revoked_at": None,
            "user_agent": request.headers.get("user-agent", "")[:200],
            "ip": client_ip(request),
        }
    )
    set_session_cookies(
        response,
        create_access_token(user["_id"], user["role"], family_id),
        refresh_token,
    )


async def revoke(db: AsyncDatabase, query: dict[str, Any]) -> None:
    await db.sessions.update_many({**query, "revoked_at": None}, {"$set": {"revoked_at": _now()}})


async def issue_email_token(
    db: AsyncDatabase, user_id: str, purpose: str, ttl: timedelta, data: dict[str, Any] | None = None
) -> str:
    token = new_opaque_token()
    now = _now()
    # Um link novo invalida os anteriores do mesmo tipo.
    await db.email_tokens.update_many(
        {"user_id": user_id, "purpose": purpose, "used_at": None},
        {"$set": {"used_at": now}},
    )
    await db.email_tokens.insert_one(
        {
            "token_hash": hash_token(token),
            "user_id": user_id,
            "purpose": purpose,
            "created_at": now,
            "expires_at": now + ttl,
            "used_at": None,
            # Dados do pedido (ex.: o e-mail novo numa troca de e-mail).
            "data": data or {},
        }
    )
    return token


async def consume_email_token(db: AsyncDatabase, token: str, purpose: str) -> dict[str, Any]:
    doc = await db.email_tokens.find_one_and_update(
        {
            "token_hash": hash_token(token),
            "purpose": purpose,
            "used_at": None,
            "expires_at": {"$gt": _now()},
        },
        {"$set": {"used_at": _now()}},
        return_document=ReturnDocument.AFTER,
    )
    if doc is None:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST,
            "invalid_token",
            "Este link é inválido ou já expirou. Peça um novo.",
        )
    return doc


def link(path: str, token: str) -> str:
    return f"{get_settings().app_base_url}{path}?{urlencode({'token': token})}"


async def ensure_can_sign_in(db: AsyncDatabase, user: dict[str, Any]) -> None:
    """Regras de estado da conta na entrada, iguais para senha, Google e Apple.

    - Suspensa: não entra.
    - Com exclusão agendada: entrar de novo cancela a exclusão (é o "desistir" dos 7 dias).
    """
    from clipo_api.observability.logs import audit, record

    status_ = user.get("status", "active")
    if status_ == "suspended":
        await record(
            "auth",
            "login.failed",
            "Login em conta suspensa",
            level="warning",
            outcome="denied",
            user_id=user["_id"],
            details={"reason": "suspended"},
        )
        raise ApiError(
            status.HTTP_403_FORBIDDEN, "account_suspended", "Esta conta está suspensa. Fale com o suporte."
        )
    if status_ == "pending_deletion":
        await db.users.update_one(
            {"_id": user["_id"]},
            {
                "$set": {"status": "active"},
                "$unset": {"deletion_requested_at": "", "deletion_scheduled_for": ""},
            },
        )
        user["status"] = "active"
        await record(
            "auth",
            "account.deletion_cancelled",
            "Exclusão cancelada ao entrar de novo",
            outcome="success",
            user_id=user["_id"],
        )
        await audit("account.deletion_cancelled", actor_id=user["_id"], target_user_id=user["_id"])

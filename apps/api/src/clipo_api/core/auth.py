"""Quem está chamando. Toda rota protegida depende de `current_user` (ou `require_role`)."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

import jwt
from fastapi import Depends, Request, status

from clipo_api.core.errors import ApiError
from clipo_api.core.middleware import ACCESS_COOKIE
from clipo_api.core.security import AccessClaims, decode_access_token
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import user_id_var

ROLES = ("user", "support", "admin", "super_admin")


@dataclass(frozen=True)
class CurrentUser:
    id: str
    role: str
    family_id: str
    impersonator_id: str | None = None


def _unauthorized(message: str = "Entre na sua conta para continuar.") -> ApiError:
    return ApiError(status.HTTP_401_UNAUTHORIZED, "unauthorized", message)


def _access_token(request: Request) -> str:
    # Navegador: cookie HttpOnly. Outros clientes (scripts, apps): cabeçalho Bearer.
    token = request.cookies.get(ACCESS_COOKIE)
    if token:
        return token
    header = request.headers.get("authorization", "")
    if header.startswith("Bearer ") and len(header) > len("Bearer "):
        return header.removeprefix("Bearer ").strip()
    raise _unauthorized()


async def current_user(request: Request, db: MongoDb) -> CurrentUser:
    try:
        claims = decode_access_token(_access_token(request))
    except jwt.PyJWTError as exc:
        raise _unauthorized("Sua sessão expirou. Entre de novo.") from exc

    # O token dura 15 min, mas sair da conta precisa valer na hora: a família de sessões
    # tem que continuar ativa. É uma busca por índice a cada requisição.
    active = await db.sessions.find_one(
        {
            "family_id": claims.family_id,
            "revoked_at": None,
            "expires_at": {"$gt": datetime.now(UTC)},
        },
        projection={"_id": 1},
    )
    if active is None:
        raise _unauthorized("Sua sessão foi encerrada. Entre de novo.")
    # Logs gravados daqui em diante nesta requisição já saem com o usuário.
    user_id_var.set(claims.user_id)
    if claims.impersonator_id:
        await _impersonated(request, claims)
    return CurrentUser(
        id=claims.user_id,
        role=claims.role,
        family_id=claims.family_id,
        impersonator_id=claims.impersonator_id,
    )


SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


async def _impersonated(request: Request, claims: AccessClaims) -> None:
    """Admin vendo a conta de outra pessoa: só leitura, e cada página vista fica registrada."""
    from clipo_api.observability.logs import record

    blocked = request.method not in SAFE_METHODS
    await record(
        "admin",
        "impersonation.blocked" if blocked else "impersonation.request",
        f"{'Bloqueado' if blocked else 'Admin vendo como a pessoa'}: {request.method} {request.url.path}",
        level="warning" if blocked else "info",
        outcome="denied" if blocked else "success",
        details={"impersonator_id": claims.impersonator_id, "path": request.url.path},
    )
    if blocked:
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "read_only_impersonation",
            "Você está vendo a conta como a pessoa, em modo só leitura.",
        )


AuthUser = Annotated[CurrentUser, Depends(current_user)]


def require_role(*allowed: str) -> Callable[..., CurrentUser]:
    unknown = set(allowed) - set(ROLES)
    if unknown:
        raise ValueError(f"papéis desconhecidos: {unknown}")

    async def _check(user: AuthUser) -> CurrentUser:
        if user.role not in allowed:
            raise ApiError(
                status.HTTP_403_FORBIDDEN,
                "forbidden",
                "Você não tem permissão para isso.",
            )
        return user

    return _check

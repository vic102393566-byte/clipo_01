"""Limite de requisições guardado no Mongo, para valer igual em todas as instâncias da API."""

import math
import time
from datetime import UTC, datetime, timedelta

from fastapi import Request, status
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.config import get_settings
from clipo_api.core.errors import ApiError

_AUTH_SCOPES = {"login", "register", "refresh", "verify", "resend", "forgot", "reset", "change-password"}


def client_ip(request: Request) -> str:
    if get_settings().trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "desconhecido"


async def hit(db: AsyncDatabase, scope: str, identity: str, *, limit: int, window_seconds: int) -> None:
    """Conta uma tentativa na janela atual e levanta 429 quando passa do limite.

    A chave inclui o número da janela, então documentos antigos não interferem mesmo antes
    do TTL do Mongo (que roda a cada ~60 s) apagá-los.
    """
    now = time.time()
    window = int(now // window_seconds)
    key = f"{scope}:{identity}:{window}"
    doc = await db.rate_limits.find_one_and_update(
        {"_id": key},
        {
            "$inc": {"count": 1},
            "$setOnInsert": {"expires_at": datetime.now(UTC) + timedelta(seconds=window_seconds * 2)},
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    if doc["count"] > limit:
        retry_after = max(1, math.ceil((window + 1) * window_seconds - now))
        if doc["count"] == limit + 1:
            # Registra só o primeiro bloqueio da janela, para um ataque não lotar o log.
            from clipo_api.observability.logs import record

            category = "auth" if scope.split(":")[0] in _AUTH_SCOPES else "system"
            await record(
                category,
                "rate_limited",
                f"Limite de tentativas atingido em {scope}",
                level="warning",
                outcome="denied",
                details={
                    "scope": scope,
                    "identity": identity,
                    "limit": limit,
                    "window_seconds": window_seconds,
                },
            )
        raise ApiError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "rate_limited",
            f"Muitas tentativas. Tente de novo em {retry_after} s.",
            headers={"Retry-After": str(retry_after)},
        )

"""Contas de redes sociais conectadas: tokens criptografados e renovação automática.

- Antes de cada uso, o token de acesso é renovado se vence em menos de 5 minutos.
- O worker renova, a cada 10 minutos, tudo o que vence nas próximas 24 h, para a pessoa nunca
  encontrar a conta desconectada na hora de publicar.
- Se a rede recusar a renovação (acesso revogado), a conexão fica "precisa reconectar".
- Só um processo renova um token por vez (trava no próprio documento).
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.observability.logs import record
from clipo_api.services import connectors, crypto
from clipo_api.services.connectors.base import Account, ConnectorError, ReconnectRequired, TokenSet

REFRESH_BEFORE = timedelta(minutes=5)
PROACTIVE_WINDOW = timedelta(hours=24)
REFRESH_LOCK = timedelta(seconds=30)


def _now() -> datetime:
    return datetime.now(UTC)


def connection_id(user_id: str, platform: str) -> str:
    return f"{user_id}:{platform}"


async def save(
    db: AsyncDatabase, user_id: str, platform: str, tokens: TokenSet, account: Account
) -> dict[str, Any]:
    now = _now()
    doc = {
        "user_id": user_id,
        "platform": platform,
        "account": account.as_dict(),
        "tokens": crypto.encrypt(tokens.secrets()),
        "scope": tokens.scope,
        "access_expires_at": tokens.expires_at,
        "refresh_expires_at": tokens.refresh_expires_at,
        "status": "active",
        "last_error": None,
        "refreshing_until": None,
        "updated_at": now,
        "schema_version": 1,
    }
    return await db.connections.find_one_and_update(
        {"_id": connection_id(user_id, platform)},
        {"$set": doc, "$setOnInsert": {"connected_at": now}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )


async def mark_reconnect(db: AsyncDatabase, conn: dict[str, Any], reason: str) -> None:
    from clipo_api.services.notifications import notify

    changed = await db.connections.update_one(
        {"_id": conn["_id"]},
        {
            "$set": {
                "status": "needs_reconnect",
                "last_error": reason[:300],
                "updated_at": _now(),
                "refreshing_until": None,
            }
        },
    )
    await record(
        "integration",
        "token.reconnect_required",
        f"Conexão precisa ser refeita: {reason}",
        level="warning",
        outcome="failure",
        user_id=conn["user_id"],
        platform=conn["platform"],
    )
    if changed.modified_count:
        label = connectors.get(conn["platform"]).label
        await notify(
            db,
            conn["user_id"],
            "reconnect_required",
            f"Conecte o {label} de novo",
            f"A conexão com o {label} expirou ou foi revogada. Enquanto isso, as publicações agendadas "
            "para essa rede não saem.",
            "/contas",
            dedupe_key=f"reconnect:{conn['_id']}:{datetime.now(UTC):%Y-%m-%d}",
        )


async def refresh_tokens(db: AsyncDatabase, conn: dict[str, Any], *, reason: str) -> dict[str, Any]:
    """Renova e grava. Devolve os segredos novos. Levanta ReconnectRequired se a rede recusar."""
    connector = connectors.get(conn["platform"])
    now = _now()
    # Trava: se outro processo já está renovando, espera ele e usa o resultado.
    locked = await db.connections.find_one_and_update(
        {"_id": conn["_id"], "$or": [{"refreshing_until": None}, {"refreshing_until": {"$lt": now}}]},
        {"$set": {"refreshing_until": now + REFRESH_LOCK}},
        return_document=ReturnDocument.AFTER,
    )
    if locked is None:
        current = await db.connections.find_one({"_id": conn["_id"]})
        return crypto.decrypt(current["tokens"])
    try:
        new = await connector.refresh(crypto.decrypt(locked["tokens"]))
    except ReconnectRequired as exc:
        await mark_reconnect(db, locked, exc.message)
        raise
    except ConnectorError as exc:
        await db.connections.update_one(
            {"_id": conn["_id"]}, {"$set": {"refreshing_until": None, "last_error": exc.message}}
        )
        await record(
            "integration",
            "token.refresh_failed",
            f"Renovação do token falhou: {exc.message}",
            level="error",
            outcome="failure",
            user_id=conn["user_id"],
            platform=conn["platform"],
        )
        raise
    await db.connections.update_one(
        {"_id": conn["_id"]},
        {
            "$set": {
                "tokens": crypto.encrypt(new.secrets()),
                "access_expires_at": new.expires_at,
                "refresh_expires_at": new.refresh_expires_at or locked.get("refresh_expires_at"),
                "status": "active",
                "last_error": None,
                "refreshing_until": None,
                "last_refresh_at": _now(),
                "updated_at": _now(),
            }
        },
    )
    await record(
        "integration",
        "token.refreshed",
        f"Token do {connector.label} renovado ({reason})",
        outcome="success",
        user_id=conn["user_id"],
        platform=conn["platform"],
        details={"expires_at": new.expires_at.isoformat() if new.expires_at else None, "reason": reason},
    )
    return new.secrets()


async def access(db: AsyncDatabase, user_id: str, platform: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Conexão e tokens prontos para usar, renovando antes se estiverem para vencer."""
    conn = await db.connections.find_one({"_id": connection_id(user_id, platform)})
    if conn is None:
        raise ConnectorError("not_connected", "Esta rede não está conectada.")
    if conn["status"] == "needs_reconnect":
        raise ReconnectRequired()
    try:
        tokens = crypto.decrypt(conn["tokens"])
    except crypto.InvalidToken as exc:
        await mark_reconnect(db, conn, "tokens ilegíveis (a chave de criptografia mudou?)")
        raise ReconnectRequired() from exc
    expires = conn.get("access_expires_at")
    if expires and expires - _now() < REFRESH_BEFORE:
        tokens = await refresh_tokens(db, conn, reason="antes de usar")
    return conn, tokens


async def refresh_expiring(db: AsyncDatabase) -> int:
    """Manutenção do worker: renova o que vence nas próximas 24 h."""
    limit = _now() + PROACTIVE_WINDOW
    count = 0
    async for conn in db.connections.find({"status": "active", "access_expires_at": {"$lt": limit}}):
        try:
            await refresh_tokens(db, conn, reason="renovação automática")
            count += 1
        except ConnectorError:
            continue  # já foi para o log e, se for o caso, marcado para reconectar
    return count


async def within_plan(db: AsyncDatabase, user_id: str, platform: str) -> bool:
    """O plano limita quantas redes ficam conectadas. Depois de descer de plano, valem as mais antigas."""
    from clipo_api.core.plans import get_plan

    user = await db.users.find_one({"_id": user_id}, projection={"plan_id": 1})
    limit = (await get_plan(db, (user or {}).get("plan_id"))).social_accounts
    oldest = (
        await db.connections.find({"user_id": user_id}, projection={"platform": 1})
        .sort("connected_at", 1)
        .to_list()
    )
    platforms = [c["platform"] for c in oldest]
    if platform in platforms:
        return platform in platforms[:limit]
    return len(platforms) < limit


def public_connection(platform: str, conn: dict[str, Any] | None) -> dict[str, Any]:
    connector = connectors.get(platform)
    return {
        "platform": platform,
        "label": connector.label,
        "configured": connector.configured(),
        "connected": conn is not None,
        "status": conn["status"] if conn else "disconnected",
        "account": conn["account"] if conn else None,
        "connected_at": conn["connected_at"].isoformat() if conn else None,
        "access_expires_at": conn["access_expires_at"].isoformat()
        if conn and conn.get("access_expires_at")
        else None,
        "last_error": conn.get("last_error") if conn else None,
        "supports_delete": connector.supports_delete,
    }

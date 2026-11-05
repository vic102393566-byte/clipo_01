"""LGPD: exportar os dados da pessoa e apagar a conta de vez depois do prazo de desistência."""

import logging
from datetime import UTC, datetime
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.observability.logs import audit, record
from clipo_api.services import asaas, storage

log = logging.getLogger("clipo.lgpd")

# Coleções com dados de um usuário, pelo campo que aponta para ele.
USER_COLLECTIONS: dict[str, str] = {
    "videos": "user_id",
    "clips": "user_id",
    "uploads": "user_id",
    "jobs": "user_id",
    "publications": "user_id",
    "transcripts": "user_id",
    "suggestions": "user_id",
    "ai_calls": "user_id",
    "ai_usage": "user_id",
    "payments": "user_id",
    "coupon_redemptions": "user_id",
    "notifications": "user_id",
    "sessions": "user_id",
    "email_tokens": "user_id",
    "email_changes": "user_id",
    "social_accounts": "user_id",
    "connections": "user_id",
    "diagnostics": "user_id",
    "subscriptions": "_id",
    # Workspace: convites que a pessoa fez, conteúdo do workspace e onde ela era membro.
    "workspace_members": "workspace_id",
    "assets": "user_id",
    "templates": "user_id",
    "ideas": "user_id",
    "scripts": "user_id",
    "metrics": "user_id",
    "follower_snapshots": "user_id",
    "webhooks": "user_id",
    "webhook_deliveries": "user_id",
    "settings": "_id",
}


def _clean(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


async def export_user_data(db: AsyncDatabase, user_id: str) -> dict[str, Any]:
    """Tudo o que o Clipo guarda sobre a pessoa, sem segredos (hash de senha, tokens)."""
    user = await db.users.find_one({"_id": user_id}, projection={"password_hash": 0})
    videos = await db.videos.find({"user_id": user_id}).to_list()
    clips = await db.clips.find({"user_id": user_id}).to_list()
    sessions = (
        await db.sessions.find({"user_id": user_id}, projection={"token_hash": 0})
        .sort("created_at", -1)
        .to_list(200)
    )
    social = await db.connections.find({"user_id": user_id}, projection={"tokens": 0}).to_list()
    subscription = await db.subscriptions.find_one({"_id": user_id})
    publications = await db.publications.find({"user_id": user_id}).to_list()
    payments = await db.payments.find({"user_id": user_id}).to_list()
    transcripts = await db.transcripts.find({"user_id": user_id}).to_list()
    suggestions = await db.suggestions.find({"user_id": user_id}).to_list()
    notifications = await db.notifications.find({"user_id": user_id}).to_list()
    logs = await db.system_logs.find({"user_id": user_id}).sort("created_at", -1).to_list(5000)
    return _clean(
        {
            "exported_at": datetime.now(UTC),
            "account": user,
            "videos": videos,
            "clips": clips,
            "publications": publications,
            "notifications": notifications,
            "subscription": subscription,
            "payments": payments,
            "transcripts": transcripts,
            "suggestions": suggestions,
            "social_accounts": social,
            "sessions": sessions,
            "activity_logs": logs,
        }
    )


async def purge_user(db: AsyncDatabase, user_id: str) -> dict[str, int]:
    """Apaga a conta, os registros e todos os arquivos no S3. A auditoria fica (exigência legal)."""
    removed: dict[str, int] = {}
    # Para as cobranças no Asaas antes de apagar a assinatura.
    sub = await db.subscriptions.find_one({"_id": user_id})
    for remote in (
        (sub or {}).get("asaas_subscription_id"),
        ((sub or {}).get("checkout") or {}).get("asaas_subscription_id"),
    ):
        if remote:
            try:
                await asaas.cancel_subscription(remote)
            except asaas.AsaasError as exc:
                await record(
                    "payment",
                    "subscription.remote_cancel_failed",
                    exc.message,
                    level="error",
                    outcome="failure",
                    details={"asaas_subscription_id": remote, "reason": "account_purge"},
                )
    for collection, field in USER_COLLECTIONS.items():
        result = await db[collection].delete_many({field: user_id})
        removed[collection] = result.deleted_count
    await db.workspace_members.delete_many({"user_id": user_id})
    try:
        removed["files"] = await storage.delete_prefix(storage.user_prefix(user_id))
    except storage.StorageNotConfigured:
        removed["files"] = 0
    await db.users.delete_one({"_id": user_id})
    # Os logs do sistema perdem o vínculo com a pessoa, mas continuam para investigação.
    await db.system_logs.update_many({"user_id": user_id}, {"$set": {"user_id": None}})
    return removed


async def purge_due_accounts(db: AsyncDatabase) -> int:
    """Apaga as contas cujo prazo de desistência já passou. Seguro para rodar a qualquer hora."""
    now = datetime.now(UTC)
    count = 0
    async for user in db.users.find(
        {"status": "pending_deletion", "deletion_scheduled_for": {"$lte": now}}, projection={"_id": 1}
    ):
        removed = await purge_user(db, user["_id"])
        await record(
            "system",
            "account.purged",
            "Conta excluída de vez (LGPD)",
            outcome="success",
            user_id=None,
            details={"removed": removed},
        )
        await audit(
            "account.purged", actor_id="system", target_user_id=user["_id"], details={"removed": removed}
        )
        count += 1
    return count

"""Avisos para a pessoa: dentro do sistema (sino) e, conforme as preferências, por e-mail.

Tipos:
- publish_success: uma publicação saiu (preferência "publish_success")
- publish_failure: uma publicação falhou de vez (preferência "publish_failure")
- reconnect_required: uma rede precisa ser conectada de novo (sempre por e-mail: sem isso nada publica)
- storage_alert: o espaço do plano passou de 90% (preferência "storage_alert"), uma vez por mês
- billing: pagamento, teste grátis, atraso e rebaixamento (sempre por e-mail: mexe no plano)
"""

from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from clipo_api.core.config import get_settings
from clipo_api.observability.logs import record
from clipo_api.services.email import send_notification_email

Kind = Literal["publish_success", "publish_failure", "reconnect_required", "storage_alert", "billing"]
RETENTION = timedelta(days=90)
# Qual preferência de e-mail vale para cada tipo (None = sempre manda).
EMAIL_PREFERENCE: dict[str, str | None] = {
    "publish_success": "publish_success",
    "publish_failure": "publish_failure",
    "reconnect_required": None,
    "storage_alert": "storage_alert",
    "billing": None,
}
DEFAULT_PREFS = {"publish_success": True, "publish_failure": True, "storage_alert": True}
ACTION_LABELS = {
    "publish_success": "Ver publicação",
    "publish_failure": "Ver o que aconteceu",
    "reconnect_required": "Conectar de novo",
    "storage_alert": "Ver meu espaço",
    "billing": "Ver meu plano",
}


async def notify(
    db: AsyncDatabase,
    user_id: str,
    kind: Kind,
    title: str,
    body: str,
    link: str,
    *,
    dedupe_key: str | None = None,
) -> bool:
    """Cria o aviso e manda o e-mail se a pessoa quiser. Devolve False se já tinha sido avisado."""
    now = datetime.now(UTC)
    doc = {
        "_id": uuid4().hex,
        "user_id": user_id,
        "kind": kind,
        "title": title[:150],
        "body": body[:600],
        "link": link,
        "read_at": None,
        "created_at": now,
        "expires_at": now + RETENTION,
    }
    if dedupe_key:
        doc["dedupe_key"] = dedupe_key
    try:
        await db.notifications.insert_one(doc)
    except DuplicateKeyError:
        return False

    user = await db.users.find_one({"_id": user_id}, projection={"email": 1, "notifications": 1})
    pref = EMAIL_PREFERENCE[kind]
    wants_email = user is not None and (
        pref is None or {**DEFAULT_PREFS, **(user.get("notifications") or {})}.get(pref, True)
    )
    if wants_email:
        await send_notification_email(
            user["email"], title, body, f"{get_settings().app_base_url}{link}", ACTION_LABELS[kind]
        )
    await record("system", f"notification.{kind}", title, user_id=user_id, details={"email": wants_email})
    return True


async def storage_check(db: AsyncDatabase, user_id: str) -> None:
    """Avisa uma vez por mês quando o espaço usado passa de 90% do plano."""
    from clipo_api.services.quota import usage

    current = await usage(db, user_id)
    if current.storage_limit_bytes and current.storage_used_bytes / current.storage_limit_bytes >= 0.9:
        percent = round(100 * current.storage_used_bytes / current.storage_limit_bytes)
        await notify(
            db,
            user_id,
            "storage_alert",
            f"Seu espaço está {percent}% ocupado",
            "Quando o espaço acabar, novos envios e cortes param. Libere vídeos antigos ou mude de plano.",
            "/armazenamento",
            dedupe_key=f"storage:{datetime.now(UTC):%Y-%m}",
        )


def public_notification(n: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": n["_id"],
        "kind": n["kind"],
        "title": n["title"],
        "body": n["body"],
        "link": n["link"],
        "read": n.get("read_at") is not None,
        "created_at": n["created_at"].isoformat(),
    }

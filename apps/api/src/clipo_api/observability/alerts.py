"""Alerta por e-mail quando uma integração começa a falhar em sequência.

Regra: N erros do mesmo evento e plataforma em X minutos disparam um e-mail para os admins.
Depois disso, o mesmo alerta fica em silêncio por um tempo para não lotar a caixa de entrada.
"""

from datetime import UTC, datetime, timedelta
from html import escape
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from clipo_api.core.config import get_settings
from clipo_api.services.email import send_email


async def maybe_alert(db: AsyncDatabase, doc: dict[str, Any]) -> bool:
    settings = get_settings()
    now = datetime.now(UTC)
    window_start = now - timedelta(minutes=settings.alert_window_minutes)
    key = {"category": doc["category"], "event": doc["event"], "platform": doc["platform"]}
    recent = await db.system_logs.count_documents(
        {**key, "level": "error", "created_at": {"$gte": window_start}}
    )
    if recent < settings.alert_error_threshold:
        return False

    # Um alerta por evento a cada período de silêncio, mesmo com várias instâncias da API.
    alert_id = f"{doc['category']}:{doc['event']}:{doc['platform'] or '-'}"
    try:
        await db.alerts.insert_one(
            {
                "_id": alert_id,
                "created_at": now,
                "expires_at": now + timedelta(minutes=settings.alert_silence_minutes),
                "count": recent,
            }
        )
    except DuplicateKeyError:
        return False

    admins = [
        u["email"] async for u in db.users.find({"role": {"$in": ["admin", "super_admin"]}}, {"email": 1})
    ]
    if not admins:
        return False
    label = f"{doc['category']} · {doc['event']}" + (f" · {doc['platform']}" if doc["platform"] else "")
    subject = f"[Clipo] {recent} falhas em {label}"
    text = (
        f"{recent} erros em {settings.alert_window_minutes} minutos em {label}.\n\n"
        f"Último erro: {doc['message']}\nRequisição: {doc['request_id'] or '-'}\n\n"
        "Consulte os logs do sistema para os detalhes."
    )
    html = (
        f"<p><strong>{recent} erros</strong> em {settings.alert_window_minutes} minutos em "
        f"<strong>{escape(label)}</strong>.</p><p>Último erro: {escape(doc['message'])}<br>"
        f"Requisição: <code>{escape(doc['request_id'] or '-')}</code></p>"
        "<p>Consulte os logs do sistema para os detalhes.</p>"
    )
    for email in admins:
        await send_email(email, subject, text, html)
    return True

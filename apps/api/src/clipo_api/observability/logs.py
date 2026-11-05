"""Log do sistema e auditoria, gravados no MongoDB e consultáveis dentro da plataforma.

- `record(...)`: um evento do sistema (login, envio de vídeo, chamada a rede social, webhook,
  job, erro). Vai para `system_logs` e também para a saída padrão em JSON.
- `audit(...)`: uma ação sensível (troca de senha, papel, ação de admin, exclusão de conta).
  Vai para `audit_logs`, guardado por mais tempo.

O identificador da requisição e o usuário logado entram sozinhos, pelo contexto da requisição.
Gravar log nunca derruba a operação: se o banco falhar, o evento fica na saída padrão.
"""

import contextvars
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.config import get_settings
from clipo_api.observability.redact import redact, redact_text

Level = Literal["info", "warning", "error"]
Category = Literal[
    "auth",
    "video",
    "integration",
    "webhook",
    "job",
    "publication",
    "payment",
    "ai",
    "admin",
    "system",
    "workspace",
    "content",
    "analytics",
]
Outcome = Literal["success", "failure", "denied"]

LEVELS: tuple[Level, ...] = ("info", "warning", "error")
CATEGORIES: tuple[Category, ...] = (
    "auth",
    "video",
    "integration",
    "webhook",
    "job",
    "publication",
    "payment",
    "ai",
    "admin",
    "system",
    "workspace",
    "content",
    "analytics",
)

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("clipo_request_id", default=None)
user_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("clipo_user_id", default=None)

_stdout = logging.getLogger("clipo.events")
_db: AsyncDatabase | None = None


def configure(db: AsyncDatabase | None) -> None:
    """Chamado na subida da API (e do worker) com o banco onde os logs são gravados."""
    global _db
    _db = db


async def record(
    category: Category,
    event: str,
    message: str,
    *,
    level: Level = "info",
    outcome: Outcome | None = None,
    user_id: str | None = None,
    platform: str | None = None,
    duration_ms: float | None = None,
    details: dict[str, Any] | None = None,
) -> str:
    """Grava um evento e devolve o id dele. Nunca levanta exceção."""
    settings = get_settings()
    now = datetime.now(UTC)
    doc = {
        "_id": uuid4().hex,
        "created_at": now,
        "expires_at": now + timedelta(days=settings.log_retention_days),
        "level": level,
        "category": category,
        "event": event[:100],
        "message": redact_text(message)[:500],
        "outcome": outcome,
        "user_id": user_id or user_id_var.get(),
        "platform": platform,
        "request_id": request_id_var.get(),
        "duration_ms": round(duration_ms, 1) if duration_ms is not None else None,
        "details": redact(details or {}),
    }
    _stdout.log(
        {"info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}[level],
        f"{category}.{event}: {doc['message']}",
        extra={"request_id": doc["request_id"]},
    )
    if _db is None:
        return doc["_id"]
    try:
        await _db.system_logs.insert_one(doc)
        if level == "error" and category in ALERT_CATEGORIES:
            from clipo_api.observability.alerts import maybe_alert

            await maybe_alert(_db, doc)
    except Exception:
        _stdout.exception("falha ao gravar log no banco")
    return doc["_id"]


async def audit(
    action: str,
    *,
    actor_id: str | None = None,
    target_user_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Registra uma ação sensível. Nunca levanta exceção."""
    settings = get_settings()
    now = datetime.now(UTC)
    doc = {
        "_id": uuid4().hex,
        "created_at": now,
        "expires_at": now + timedelta(days=settings.audit_retention_days),
        "action": action[:100],
        "actor_id": actor_id or user_id_var.get(),
        "target_user_id": target_user_id,
        "request_id": request_id_var.get(),
        "details": redact(details or {}),
    }
    _stdout.info(f"auditoria {action}", extra={"request_id": doc["request_id"]})
    if _db is None:
        return
    try:
        await _db.audit_logs.insert_one(doc)
    except Exception:
        _stdout.exception("falha ao gravar auditoria no banco")


# Falhas repetidas nestas categorias avisam o admin por e-mail.
ALERT_CATEGORIES: frozenset[str] = frozenset(
    {"integration", "webhook", "payment", "job", "publication", "ai", "system"}
)

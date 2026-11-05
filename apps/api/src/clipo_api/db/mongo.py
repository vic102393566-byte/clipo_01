from typing import Annotated, Any

from fastapi import Depends, Request
from pymongo import ASCENDING, DESCENDING, AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import CollectionInvalid

from clipo_api.core import plans
from clipo_api.core.config import get_settings
from clipo_api.observability.logs import CATEGORIES
from clipo_api.services.ai import prompts as ai_prompts


def create_client() -> AsyncMongoClient:
    # tz_aware: datas voltam com fuso, iguais às que gravamos em UTC.
    return AsyncMongoClient(get_settings().mongodb_url, tz_aware=True)


def get_db(request: Request) -> AsyncDatabase:
    """O cliente vive no estado do app (criado no lifespan), nunca num global de módulo."""
    return request.app.state.db


MongoDb = Annotated[AsyncDatabase, Depends(get_db)]


# Validação no próprio Mongo: um documento fora do formato é recusado mesmo se o código errar.
_VALIDATORS: dict[str, dict[str, Any]] = {
    "users": {
        "$jsonSchema": {
            "bsonType": "object",
            "required": ["_id", "email", "name", "role", "plan_id", "created_at", "schema_version"],
            "properties": {
                "_id": {"bsonType": "string"},
                "email": {"bsonType": "string", "maxLength": 254},
                "name": {"bsonType": "string", "minLength": 1, "maxLength": 120},
                # Sem senha quando a conta foi criada pelo Google ou pela Apple.
                "password_hash": {"bsonType": ["string", "null"]},
                "identities": {
                    "bsonType": "array",
                    "items": {
                        "bsonType": "object",
                        "required": ["provider", "subject"],
                        "properties": {
                            "provider": {"enum": ["google", "apple"]},
                            "subject": {"bsonType": "string"},
                        },
                    },
                },
                "status": {"enum": ["active", "suspended", "pending_deletion"]},
                "locale": {"enum": ["pt-BR", "en-US"]},
                "theme": {"enum": ["dark", "light", "system"]},
                "role": {"enum": ["user", "support", "admin", "super_admin"]},
                "plan_id": {"bsonType": "string", "pattern": "^[a-z0-9_-]{2,30}$"},
                "email_verified_at": {"bsonType": ["date", "null"]},
                "created_at": {"bsonType": "date"},
                "schema_version": {"bsonType": "int"},
            },
        }
    },
    "sessions": {
        "$jsonSchema": {
            "bsonType": "object",
            "required": [
                "_id",
                "user_id",
                "family_id",
                "token_hash",
                "created_at",
                "expires_at",
            ],
            "properties": {
                "_id": {"bsonType": "string"},
                "user_id": {"bsonType": "string"},
                "family_id": {"bsonType": "string"},
                "token_hash": {"bsonType": "string", "minLength": 64, "maxLength": 64},
                "created_at": {"bsonType": "date"},
                "expires_at": {"bsonType": "date"},
                "revoked_at": {"bsonType": ["date", "null"]},
            },
        }
    },
}


_VALIDATORS["system_logs"] = {
    "$jsonSchema": {
        "bsonType": "object",
        "required": ["_id", "created_at", "expires_at", "level", "category", "event", "message"],
        "properties": {
            "level": {"enum": ["info", "warning", "error"]},
            "category": {"enum": list(CATEGORIES)},
            "event": {"bsonType": "string", "maxLength": 100},
            "message": {"bsonType": "string", "maxLength": 500},
            "outcome": {"enum": ["success", "failure", "denied", None]},
            "created_at": {"bsonType": "date"},
            "expires_at": {"bsonType": "date"},
        },
    }
}
_VALIDATORS["audit_logs"] = {
    "$jsonSchema": {
        "bsonType": "object",
        "required": ["_id", "created_at", "expires_at", "action"],
        "properties": {
            "action": {"bsonType": "string", "maxLength": 100},
            "created_at": {"bsonType": "date"},
            "expires_at": {"bsonType": "date"},
        },
    }
}


async def _ensure_validator(db: AsyncDatabase, name: str, validator: dict[str, Any]) -> None:
    try:
        await db.create_collection(name, validator=validator)
    except CollectionInvalid:
        await db.command("collMod", name, validator=validator)


async def ensure_schema(db: AsyncDatabase) -> None:
    """Coleções, validação e índices são o "schema" do Mongo: criados na subida, idempotentes."""
    for name, validator in _VALIDATORS.items():
        await _ensure_validator(db, name, validator)

    await db.users.create_index([("email", ASCENDING)], unique=True)

    await db.sessions.create_index([("token_hash", ASCENDING)], unique=True)
    await db.sessions.create_index([("user_id", ASCENDING)])
    await db.sessions.create_index([("family_id", ASCENDING)])
    # TTL: o Mongo apaga a sessão sozinho depois que ela expira.
    await db.sessions.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)

    await db.email_tokens.create_index([("token_hash", ASCENDING)], unique=True)
    await db.email_tokens.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)

    await db.rate_limits.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)

    await db.social_accounts.create_index([("user_id", ASCENDING)])

    # Logs: consulta sempre do mais novo para o mais antigo, com filtros; apagados pelo TTL.
    await db.system_logs.create_index([("created_at", DESCENDING), ("_id", DESCENDING)])
    for field in ("category", "level", "user_id", "platform", "event"):
        await db.system_logs.create_index([(field, ASCENDING), ("created_at", DESCENDING)])
    await db.system_logs.create_index([("request_id", ASCENDING)])
    await db.system_logs.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)
    await db.audit_logs.create_index([("created_at", DESCENDING), ("_id", DESCENDING)])
    await db.audit_logs.create_index([("actor_id", ASCENDING), ("created_at", DESCENDING)])
    await db.audit_logs.create_index([("target_user_id", ASCENDING), ("created_at", DESCENDING)])
    await db.audit_logs.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)
    await db.alerts.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)

    # Uma identidade do Google ou da Apple pertence a uma conta só.
    await db.users.create_index(
        [("identities.provider", ASCENDING), ("identities.subject", ASCENDING)],
        unique=True,
        partialFilterExpression={"identities.subject": {"$exists": True}},
    )
    await db.users.create_index([("status", ASCENDING), ("deletion_scheduled_for", ASCENDING)])
    await db.oauth_states.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)
    await db.email_changes.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)

    # F3: envios, vídeos, cortes, fila de jobs e travas da manutenção.
    await db.uploads.create_index([("user_id", ASCENDING), ("status", ASCENDING)])
    await db.uploads.create_index([("status", ASCENDING), ("created_at", ASCENDING)])
    await db.videos.create_index(
        [("user_id", ASCENDING), ("deleted_at", ASCENDING), ("created_at", DESCENDING)]
    )
    await db.videos.create_index([("purge_after", ASCENDING)], sparse=True)
    await db.clips.create_index([("video_id", ASCENDING), ("index", ASCENDING)])
    await db.clips.create_index([("job_id", ASCENDING), ("index", ASCENDING)])
    await db.clips.create_index([("user_id", ASCENDING), ("deleted_at", ASCENDING)])
    await db.clips.create_index([("purge_after", ASCENDING)], sparse=True)
    await db.jobs.create_index([("status", ASCENDING), ("run_at", ASCENDING)])
    await db.jobs.create_index([("status", ASCENDING), ("lease_expires_at", ASCENDING)])
    await db.jobs.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)])

    # F4: contas das redes, diagnósticos (botão de testes) e eventos de webhook já processados.
    await db.connections.create_index([("user_id", ASCENDING)])
    await db.connections.create_index([("status", ASCENDING), ("access_expires_at", ASCENDING)])
    await db.connections.create_index([("platform", ASCENDING), ("account.id", ASCENDING)])
    await db.diagnostics.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)])
    await db.webhook_events.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)

    # F5: publicações (agendador e calendário) e avisos.
    await db.publications.create_index([("status", ASCENDING), ("scheduled_at", ASCENDING)])
    await db.publications.create_index([("user_id", ASCENDING), ("scheduled_at", ASCENDING)])
    await db.publications.create_index([("source.id", ASCENDING), ("status", ASCENDING)])
    await db.publications.create_index(
        [("targets.platform", ASCENDING), ("targets.remote_id", ASCENDING)], sparse=True
    )
    await db.notifications.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)])
    await db.notifications.create_index([("user_id", ASCENDING), ("read_at", ASCENDING)])
    await db.notifications.create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)
    await db.notifications.create_index(
        [("user_id", ASCENDING), ("dedupe_key", ASCENDING)],
        unique=True,
        partialFilterExpression={"dedupe_key": {"$exists": True}},
    )

    # F6: planos, assinaturas, cobranças do Asaas e cupons.
    await db.subscriptions.create_index([("asaas_subscription_id", ASCENDING)], sparse=True)
    await db.subscriptions.create_index([("checkout.asaas_subscription_id", ASCENDING)], sparse=True)
    await db.subscriptions.create_index([("cancelled_remote_id", ASCENDING)], sparse=True)
    await db.subscriptions.create_index([("status", ASCENDING), ("trial_ends_at", ASCENDING)])
    await db.subscriptions.create_index([("status", ASCENDING), ("current_period_end", ASCENDING)])
    await db.payments.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)])
    await db.coupon_redemptions.create_index([("user_id", ASCENDING)])
    await plans.seed(db)
    # Assinaturas gravadas pela cobrança antiga (situação em português): quem estava "ativa" ou
    # "pendente" mantém o plano como cortesia; "cancelada"/"expirada" vira gratuito.
    await db.subscriptions.update_many(
        {"status": {"$in": ["ativa", "pendente"]}}, {"$set": {"status": "manual", "manual_until": None}}
    )
    await db.subscriptions.update_many(
        {"status": {"$in": ["cancelada", "expirada"]}},
        {"$set": {"status": "expired", "plan_id": plans.FREE_PLAN_ID}},
    )

    # F7: transcrições, sugestões de corte, chamadas de IA (custo e teste A/B), créditos e gasto do dia.
    await db.transcripts.create_index([("user_id", ASCENDING)])
    await db.suggestions.create_index([("video_id", ASCENDING), ("created_at", DESCENDING)])
    await db.suggestions.create_index([("job_id", ASCENDING)])
    await db.ai_calls.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)])
    await db.ai_calls.create_index([("task", ASCENDING), ("prompt_id", ASCENDING)])
    await db.ai_calls.create_index([("created_at", ASCENDING)], expireAfterSeconds=365 * 24 * 3600)
    await db.ai_usage.create_index([("user_id", ASCENDING)])
    await ai_prompts.seed(db)

    # F10: workspace compartilhado, biblioteca, modelos, ideias, roteiros, métricas, webhooks.
    await db.workspace_members.create_index([("workspace_id", ASCENDING), ("email", ASCENDING)], unique=True)
    await db.workspace_members.create_index([("user_id", ASCENDING), ("status", ASCENDING)])
    await db.workspace_members.create_index([("token_hash", ASCENDING)], sparse=True)
    for name in ("assets", "templates", "ideas", "scripts"):
        await db[name].create_index(
            [("user_id", ASCENDING), ("deleted_at", ASCENDING), ("created_at", DESCENDING)]
        )
    await db.assets.create_index([("purge_after", ASCENDING)], sparse=True)
    await db.metrics.create_index([("user_id", ASCENDING), ("day", ASCENDING)])
    await db.metrics.create_index(
        [("publication_id", ASCENDING), ("platform", ASCENDING), ("day", ASCENDING)], unique=True
    )
    await db.follower_snapshots.create_index(
        [("user_id", ASCENDING), ("platform", ASCENDING), ("day", ASCENDING)], unique=True
    )
    await db.webhooks.create_index([("user_id", ASCENDING)])
    await db.webhook_deliveries.create_index([("webhook_id", ASCENDING), ("created_at", DESCENDING)])
    await db.webhook_deliveries.create_index([("created_at", ASCENDING)], expireAfterSeconds=30 * 24 * 3600)

"""API v1 do Super Admin: pessoas, entrar como a pessoa (só leitura), fila de jobs, integrações,
painéis de erro, métricas e feature flags.

Toda rota pede uma permissão (core/permissions.py). Toda ação que muda algo grava auditoria.
Planos e cupons ficam em routers/billing.py; a IA em routers/ai.py; os logs em routers/admin_logs.py.
"""

import hashlib
import re
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, Field
from pymongo import ReturnDocument

from clipo_api.core.auth import AuthUser
from clipo_api.core.errors import ApiError
from clipo_api.core.permissions import Requires
from clipo_api.core.plans import all_plans
from clipo_api.core.security import create_access_token, new_opaque_token
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.services import asaas, billing, connectors, diagnostics, flags, jobs, processing, quota
from clipo_api.services.ai import config as ai_config
from clipo_api.services.ai import credits
from clipo_api.services.connections import public_connection
from clipo_api.services.sessions import public_user, revoke

router = APIRouter(prefix="/api/v1", tags=["admin"])

IMPERSONATION_MINUTES = 30
STAFF_RANK = {"user": 0, "support": 1, "admin": 2, "super_admin": 3}


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(v: Any) -> Any:
    return v.isoformat() if isinstance(v, datetime) else v


def _clean(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: _iso(v) for k, v in doc.items()}


async def _target(db: MongoDb, user_id: str) -> dict[str, Any]:
    user = await db.users.find_one({"_id": user_id}, projection={"password_hash": 0})
    if user is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Pessoa não encontrada.")
    return user


def _outranks(actor_role: str, target: dict[str, Any]) -> bool:
    """Só age sobre quem tem papel menor (super admin age sobre todos, menos sobre si)."""
    return actor_role == "super_admin" or STAFF_RANK[actor_role] > STAFF_RANK.get(target["role"], 0)


# ---------------------------------------------------------------- pessoas


@router.get("/admin/users")
async def list_users(
    user: Requires("users:read"),
    db: MongoDb,
    q: Annotated[str | None, Query(max_length=100)] = None,
    plan: Annotated[str | None, Query(max_length=30)] = None,
    status_: Annotated[
        Literal["active", "suspended", "pending_deletion"] | None, Query(alias="status")
    ] = None,
    role: Literal["user", "support", "admin", "super_admin"] | None = None,
    before: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, Any]:
    """Busca por nome ou e-mail, com filtros. Paginação pela data de cadastro (mais novas primeiro)."""
    query: dict[str, Any] = {}
    if q:
        pattern = re.compile(re.escape(q.strip()), re.IGNORECASE)
        query["$or"] = [{"email": pattern}, {"name": pattern}, {"_id": q.strip()}]
    if plan:
        query["plan_id"] = plan
    if status_:
        # Contas antigas não têm o campo: contam como ativas.
        query["status"] = {"$in": ["active", None]} if status_ == "active" else status_
    if role:
        query["role"] = role
    if before:
        query["created_at"] = {"$lt": before if before.tzinfo else before.replace(tzinfo=UTC)}
    users = (
        await db.users.find(query, projection={"password_hash": 0})
        .sort("created_at", -1)
        .limit(limit)
        .to_list()
    )
    ids = [u["_id"] for u in users]
    last_seen = {
        r["_id"]: r["at"]
        for r in await (
            await db.sessions.aggregate(
                [
                    {"$match": {"user_id": {"$in": ids}, "kind": {"$ne": "support"}}},
                    {"$group": {"_id": "$user_id", "at": {"$max": "$created_at"}}},
                ]
            )
        ).to_list()
    }
    subs = {s["_id"]: s for s in await db.subscriptions.find({"_id": {"$in": ids}}).to_list()}
    items = [
        {
            "id": u["_id"],
            "email": u["email"],
            "name": u["name"],
            "role": u["role"],
            "plan_id": u["plan_id"],
            "status": u.get("status", "active"),
            "subscription_status": (subs.get(u["_id"]) or {}).get("status"),
            "created_at": u["created_at"].isoformat(),
            "last_active_at": _iso(last_seen.get(u["_id"])),
        }
        for u in users
    ]
    return {
        "items": items,
        "next_before": items[-1]["created_at"] if len(items) == limit else None,
        "total": await db.users.count_documents(
            query if not before else {k: v for k, v in query.items() if k != "created_at"}
        ),
    }


@router.get("/admin/users/{user_id}")
async def get_user(user_id: str, user: Requires("users:read"), db: MongoDb) -> dict[str, Any]:
    target = await _target(db, user_id)
    sub = await billing.get_subscription(db, user_id)
    conns = {c["platform"]: c for c in await db.connections.find({"user_id": user_id}).to_list()}
    since = _now() - timedelta(days=30)
    pub_rows = await (
        await db.publications.aggregate(
            [{"$match": {"user_id": user_id}}, {"$group": {"_id": "$status", "n": {"$sum": 1}}}]
        )
    ).to_list()
    return {
        "user": {
            **public_user(target),
            "status": target.get("status", "active"),
            "created_at": target["created_at"].isoformat(),
            "suspended_reason": target.get("suspended_reason"),
            "suspended_at": _iso(target.get("suspended_at")),
        },
        "subscription": billing.public_subscription(sub, target["plan_id"]),
        "usage": (await quota.usage(db, user_id)).as_dict(),
        "ai_credits": await credits.usage(db, user_id),
        "connections": [public_connection(p, conns.get(p)) for p in connectors.CONNECTORS],
        "counts": {
            "videos": await db.videos.count_documents({"user_id": user_id, "deleted_at": None}),
            "clips": await db.clips.count_documents({"user_id": user_id, "deleted_at": None}),
            "publications": {r["_id"]: r["n"] for r in pub_rows},
            "failed_jobs_30d": await db.jobs.count_documents(
                {"user_id": user_id, "status": "failed", "created_at": {"$gte": since}}
            ),
            "active_sessions": len(
                await db.sessions.distinct(
                    "family_id", {"user_id": user_id, "revoked_at": None, "expires_at": {"$gt": _now()}}
                )
            ),
        },
        "recent_audit": [
            _clean({k: v for k, v in a.items() if k != "expires_at"})
            for a in await db.audit_logs.find({"target_user_id": user_id})
            .sort("created_at", -1)
            .limit(20)
            .to_list()
        ],
    }


class SuspendIn(BaseModel):
    reason: Annotated[str, Field(min_length=3, max_length=300)]


@router.post("/admin/users/{user_id}/suspend")
async def suspend_user(
    user_id: str, body: SuspendIn, actor: Requires("users:manage"), db: MongoDb
) -> dict[str, Any]:
    """Bloqueia a entrada e derruba as sessões. Publicações agendadas não saem enquanto estiver suspensa."""
    target = await _target(db, user_id)
    if user_id == actor.id or not _outranks(actor.role, target):
        raise ApiError(status.HTTP_403_FORBIDDEN, "forbidden", "Você não pode suspender esta conta.")
    if target.get("status") == "suspended":
        raise ApiError(status.HTTP_409_CONFLICT, "already_suspended", "A conta já está suspensa.")
    await db.users.update_one(
        {"_id": user_id},
        {
            "$set": {
                "status": "suspended",
                "suspended_reason": body.reason,
                "suspended_at": _now(),
                "suspended_by": actor.id,
            }
        },
    )
    await revoke(db, {"user_id": user_id})
    paused = await db.publications.update_many(
        {"user_id": user_id, "status": "scheduled"},
        {"$set": {"status": "draft", "paused_by_suspension": True}},
    )
    await audit(
        "user.suspended",
        target_user_id=user_id,
        details={"reason": body.reason, "paused": paused.modified_count},
    )
    await record(
        "admin",
        "user.suspended",
        f"Conta suspensa: {body.reason}",
        outcome="success",
        details={"target_user_id": user_id},
    )
    return {"id": user_id, "status": "suspended", "publications_paused": paused.modified_count}


@router.post("/admin/users/{user_id}/reactivate")
async def reactivate_user(user_id: str, actor: Requires("users:manage"), db: MongoDb) -> dict[str, Any]:
    target = await _target(db, user_id)
    if target.get("status") != "suspended":
        raise ApiError(status.HTTP_409_CONFLICT, "not_suspended", "A conta não está suspensa.")
    await db.users.update_one(
        {"_id": user_id},
        {
            "$set": {"status": "active"},
            "$unset": {"suspended_reason": "", "suspended_at": "", "suspended_by": ""},
        },
    )
    # As publicações pausadas voltam como rascunho: a pessoa reagenda (a data pode ter passado).
    await audit("user.reactivated", target_user_id=user_id)
    await record(
        "admin", "user.reactivated", "Conta reativada", outcome="success", details={"target_user_id": user_id}
    )
    return {"id": user_id, "status": "active"}


class CreditsIn(BaseModel):
    amount: Annotated[int, Field(ge=-10000, le=10000)]
    reason: Annotated[str, Field(min_length=3, max_length=300)]


@router.post("/admin/users/{user_id}/credits")
async def grant_credits(
    user_id: str, body: CreditsIn, actor: Requires("users:manage"), db: MongoDb
) -> dict[str, Any]:
    """Créditos de IA extras (ou retirados) só neste mês."""
    await _target(db, user_id)
    if body.amount == 0:
        raise ApiError(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_amount", "Informe uma quantidade.")
    usage = await credits.grant_bonus(db, user_id, body.amount)
    await audit(
        "user.credits_granted", target_user_id=user_id, details={"amount": body.amount, "reason": body.reason}
    )
    return {"credits": usage}


class ImpersonateIn(BaseModel):
    reason: Annotated[str, Field(min_length=3, max_length=300)]


@router.post("/admin/users/{user_id}/impersonate", status_code=status.HTTP_201_CREATED)
async def impersonate(
    user_id: str, body: ImpersonateIn, actor: Requires("users:impersonate"), db: MongoDb
) -> dict[str, Any]:
    """Entrar como a pessoa, só leitura, por 30 min. Devolve um token (cabeçalho Authorization: Bearer).

    A sessão aparece para a pessoa como "suporte" (ela vê e pode encerrar), cada página vista vai para
    o log, e qualquer tentativa de mudar algo é bloqueada.
    """
    target = await _target(db, user_id)
    if target["role"] != "user" or user_id == actor.id:
        raise ApiError(status.HTTP_403_FORBIDDEN, "forbidden", "Só dá para entrar como contas de clientes.")
    now = _now()
    family = f"imp-{uuid4().hex}"
    expires = now + timedelta(minutes=IMPERSONATION_MINUTES)
    await db.sessions.insert_one(
        {
            "_id": uuid4().hex,
            "user_id": user_id,
            "family_id": family,
            # Sessão sem renovação: o hash é de um valor que ninguém recebe.
            "token_hash": hashlib.sha256(new_opaque_token().encode()).hexdigest(),
            "created_at": now,
            "started_at": now,
            "expires_at": expires,
            "revoked_at": None,
            "kind": "support",
            "impersonator_id": actor.id,
            "reason": body.reason,
            "user_agent": "Suporte do Clipo (somente leitura)",
            "ip": None,
        }
    )
    token = create_access_token(
        user_id, target["role"], family, impersonator_id=actor.id, minutes=IMPERSONATION_MINUTES
    )
    await audit(
        "impersonation.started", target_user_id=user_id, details={"reason": body.reason, "session": family}
    )
    await record(
        "admin",
        "impersonation.started",
        f"Admin entrou como a pessoa: {body.reason}",
        outcome="success",
        details={"target_user_id": user_id, "session": family},
    )
    return {
        "session_id": family,
        "access_token": token,
        "token_type": "Bearer",
        "expires_at": expires.isoformat(),
        "read_only": True,
    }


@router.get("/admin/impersonations")
async def list_impersonations(user: Requires("audit:read"), db: MongoDb) -> dict[str, Any]:
    docs = (
        await db.sessions.find({"kind": "support", "revoked_at": None, "expires_at": {"$gt": _now()}})
        .sort("created_at", -1)
        .to_list(200)
    )
    return {
        "items": [
            {
                "session_id": d["family_id"],
                "user_id": d["user_id"],
                "impersonator_id": d["impersonator_id"],
                "reason": d.get("reason"),
                "started_at": d["created_at"].isoformat(),
                "expires_at": d["expires_at"].isoformat(),
            }
            for d in docs
        ]
    }


@router.delete("/admin/impersonations/{session_id}")
async def stop_impersonation(
    session_id: str, actor: Requires("users:impersonate"), db: MongoDb
) -> dict[str, Any]:
    doc = await db.sessions.find_one({"family_id": session_id, "kind": "support"})
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Sessão não encontrada.")
    await revoke(db, {"family_id": session_id})
    await audit("impersonation.stopped", target_user_id=doc["user_id"], details={"session": session_id})
    return {"ok": True}


# ---------------------------------------------------------------- fila de jobs


def _job_out(job: dict[str, Any]) -> dict[str, Any]:
    return {
        **jobs.public_job(job),
        "user_id": job["user_id"],
        "worker_id": job.get("worker_id"),
        "error": job.get("error"),
        "max_attempts": job.get("max_attempts"),
    }


@router.get("/admin/jobs")
async def list_jobs(
    user: Requires("jobs:read"),
    db: MongoDb,
    status_: Annotated[
        Literal["queued", "running", "done", "failed", "cancelled"] | None, Query(alias="status")
    ] = None,
    type_: Annotated[str | None, Query(alias="type", max_length=40)] = None,
    user_id: Annotated[str | None, Query(max_length=80)] = None,
    before: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if status_:
        query["status"] = status_
    if type_:
        query["type"] = type_
    if user_id:
        query["user_id"] = user_id
    if before:
        query["created_at"] = {"$lt": before if before.tzinfo else before.replace(tzinfo=UTC)}
    items = await db.jobs.find(query).sort("created_at", -1).limit(limit).to_list()
    summary = await (
        await db.jobs.aggregate(
            [
                {"$match": {"created_at": {"$gte": _now() - timedelta(days=1)}}},
                {"$group": {"_id": {"type": "$type", "status": "$status"}, "n": {"$sum": 1}}},
            ]
        )
    ).to_list()
    stuck = await db.jobs.count_documents({"status": "running", "lease_expires_at": {"$lt": _now()}})
    return {
        "items": [_job_out(j) for j in items],
        "last_24h": [{**r["_id"], "count": r["n"]} for r in summary],
        "stuck": stuck,
        "next_before": items[-1]["created_at"].isoformat() if len(items) == limit else None,
    }


@router.post("/admin/jobs/{job_id}/retry")
async def retry_job(job_id: str, actor: Requires("jobs:manage"), db: MongoDb) -> dict[str, Any]:
    """Põe de novo na fila um job que falhou ou foi cancelado (sem cobrar créditos outra vez)."""
    job = await db.jobs.find_one({"_id": job_id})
    if job is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Job não encontrado.")
    if job["type"] == "publication.publish":
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "use_publication_retry",
            "Publicação tem a própria nova tentativa (cuida de não publicar duas vezes).",
        )
    if job["status"] not in ("failed", "cancelled"):
        raise ApiError(
            status.HTTP_409_CONFLICT, "not_retryable", "Só dá para repetir job que falhou ou foi cancelado."
        )
    payload = job["payload"]
    if job["type"] == "video.ingest":
        video = await db.videos.find_one({"_id": payload["video_id"]})
        if video is None or video["status"] == "rejected" or video.get("deleted_at"):
            raise ApiError(status.HTTP_409_CONFLICT, "not_retryable", "O vídeo foi recusado ou removido.")
        await db.videos.update_one({"_id": video["_id"]}, {"$set": {"status": "processing", "error": None}})
    if job["type"] in ("clip.render",):
        await db.clips.update_one(
            {"_id": payload["clip_id"], "status": {"$ne": "ready"}}, {"$set": {"status": "queued"}}
        )
    now = _now()
    updated = await db.jobs.find_one_and_update(
        {"_id": job_id, "status": {"$in": ["failed", "cancelled"]}},
        {
            "$set": {
                "status": "queued",
                "attempts": 0,
                "run_at": now,
                "error": None,
                "cancel_requested": False,
                "finished_at": None,
                "message": "Na fila (repetido pelo admin)",
                "progress": 0,
                "updated_at": now,
                # Os créditos já voltaram na falha: repetir pelo admin não cobra de novo.
                "payload.credits": 0,
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise ApiError(status.HTTP_409_CONFLICT, "not_retryable", "O job mudou de estado. Atualize a tela.")
    await audit("job.retried", target_user_id=job["user_id"], details={"job_id": job_id, "type": job["type"]})
    await record("job", f"{job['type']}.admin_retry", "Job repetido pelo admin", details={"job_id": job_id})
    return {"job": _job_out(updated)}


@router.post("/admin/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, actor: Requires("jobs:manage"), db: MongoDb) -> dict[str, Any]:
    job = await db.jobs.find_one({"_id": job_id})
    if job is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Job não encontrado.")
    if job["status"] in jobs.TERMINAL:
        raise ApiError(status.HTTP_409_CONFLICT, "already_finished", "Este job já terminou.")
    changed = await jobs.request_cancel(db, job_id, job["user_id"])
    if changed and changed["status"] == "cancelled":
        await processing.cancelled_in_queue(db, changed)
    await audit(
        "job.cancelled", target_user_id=job["user_id"], details={"job_id": job_id, "type": job["type"]}
    )
    return {"job": _job_out(await db.jobs.find_one({"_id": job_id}))}


# ---------------------------------------------------------------- integrações


@router.get("/admin/integrations")
async def integrations(user: Requires("integrations:manage"), db: MongoDb) -> dict[str, Any]:
    """Saúde de cada integração nas últimas 24 h: configuração, contas, erros, webhooks e último teste."""
    since = _now() - timedelta(hours=24)
    platforms = [*connectors.CONNECTORS, "asaas", "stt", "gemini", "anthropic", "openai", "local"]
    rows = await (
        await db.system_logs.aggregate(
            [
                {"$match": {"created_at": {"$gte": since}, "platform": {"$in": platforms}}},
                {
                    "$group": {
                        "_id": "$platform",
                        "total": {"$sum": 1},
                        "errors": {"$sum": {"$cond": [{"$eq": ["$level", "error"]}, 1, 0]}},
                        "webhooks": {"$sum": {"$cond": [{"$eq": ["$category", "webhook"]}, 1, 0]}},
                    }
                },
            ]
        )
    ).to_list()
    stats = {r["_id"]: r for r in rows}

    async def last_error(platform: str) -> dict[str, Any] | None:
        doc = await db.system_logs.find_one(
            {"platform": platform, "level": "error"},
            sort=[("created_at", -1)],
            projection={"message": 1, "created_at": 1},
        )
        return {"message": doc["message"], "at": doc["created_at"].isoformat()} if doc else None

    async def last_diag(target: str) -> dict[str, Any] | None:
        doc = await db.diagnostics.find_one({"target": target}, sort=[("created_at", -1)])
        return (
            {
                "id": doc["_id"],
                "status": doc["status"],
                "at": doc["created_at"].isoformat(),
                "user_id": doc["user_id"],
            }
            if doc
            else None
        )

    networks = []
    for platform, connector in connectors.CONNECTORS.items():
        by_status = await (
            await db.connections.aggregate(
                [{"$match": {"platform": platform}}, {"$group": {"_id": "$status", "n": {"$sum": 1}}}]
            )
        ).to_list()
        s = stats.get(platform, {})
        networks.append(
            {
                "platform": platform,
                "label": connector.label,
                "configured": connector.configured(),
                "connections": {r["_id"]: r["n"] for r in by_status},
                "events_24h": s.get("total", 0),
                "errors_24h": s.get("errors", 0),
                "webhooks_24h": s.get("webhooks", 0),
                "last_error": await last_error(platform),
                "last_diagnostic": await last_diag(platform),
            }
        )
    conf = await ai_config.load(db)
    return {
        "networks": networks,
        "payments": {
            "gateway": asaas.mode(),
            "errors_24h": stats.get("asaas", {}).get("errors", 0),
            "webhooks_24h": stats.get("asaas", {}).get("webhooks", 0),
            "last_error": await last_error("asaas"),
            "last_diagnostic": await last_diag("payments"),
        },
        "ai": {
            p: {"ready": ai_config.provider_ready(p, conf), "errors_24h": stats.get(p, {}).get("errors", 0)}
            for p in ai_config.PROVIDERS
        },
    }


@router.get("/admin/diagnostics")
async def list_all_diagnostics(
    user: Requires("integrations:manage"),
    db: MongoDb,
    target: Annotated[str | None, Query(max_length=20)] = None,
    status_: Annotated[str | None, Query(alias="status", max_length=20)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    """Histórico de todos os testes (botão de testes) de todas as contas."""
    query: dict[str, Any] = {}
    if target:
        query["target"] = target
    if status_:
        query["status"] = status_
    items = await db.diagnostics.find(query).sort("created_at", -1).limit(limit).to_list()
    return {"items": [{**diagnostics.public_diagnostic(d), "user_id": d["user_id"]} for d in items]}


# ---------------------------------------------------------------- métricas


@router.get("/admin/metrics")
async def metrics(
    user: Requires("metrics:read"), db: MongoDb, days: Annotated[int, Query(ge=1, le=365)] = 30
) -> dict[str, Any]:
    now = _now()
    since = now - timedelta(days=days)

    async def active(window: timedelta) -> int:
        return len(
            await db.sessions.distinct(
                "user_id", {"created_at": {"$gte": now - window}, "kind": {"$ne": "support"}}
            )
        )

    async def group(collection: str, match: dict[str, Any], key: str) -> dict[str, int]:
        rows = await (
            await db[collection].aggregate(
                [{"$match": match}, {"$group": {"_id": f"${key}", "n": {"$sum": 1}}}]
            )
        ).to_list()
        return {str(r["_id"]): r["n"] for r in rows}

    plans = await all_plans(db)
    mrr = 0
    async for sub in db.subscriptions.find(
        {"status": {"$in": ["active", "past_due"]}, "asaas_subscription_id": {"$ne": None}}
    ):
        plan = plans.get(sub["plan_id"])
        if plan:
            mrr += plan.price_yearly_cents // 12 if sub.get("cycle") == "yearly" else plan.price_monthly_cents
    paid = await (
        await db.payments.aggregate(
            [
                {"$match": {"applied_at": {"$gte": since}}},
                {
                    "$group": {
                        "_id": None,
                        "gross": {"$sum": "$value_cents"},
                        "net": {"$sum": "$net_cents"},
                        "refunded": {
                            "$sum": {"$cond": [{"$ifNull": ["$refunded_at", False]}, "$value_cents", 0]}
                        },
                        "count": {"$sum": 1},
                    }
                },
            ]
        )
    ).to_list()
    revenue = paid[0] if paid else {"gross": 0, "net": 0, "refunded": 0, "count": 0}
    targets = await (
        await db.publications.aggregate(
            [
                {
                    "$match": {
                        "updated_at": {"$gte": since},
                        "status": {"$in": ["published", "partial", "failed"]},
                    }
                },
                {"$unwind": "$targets"},
                {"$group": {"_id": "$targets.status", "n": {"$sum": 1}}},
            ]
        )
    ).to_list()
    t = {r["_id"]: r["n"] for r in targets}
    finished = t.get("published", 0) + t.get("failed", 0)
    ai_rows = await (
        await db.ai_calls.aggregate(
            [
                {"$match": {"created_at": {"$gte": since}}},
                {
                    "$group": {
                        "_id": "$task",
                        "calls": {"$sum": 1},
                        "cost": {"$sum": {"$ifNull": ["$cost_usd", 0]}},
                    }
                },
            ]
        )
    ).to_list()
    return {
        "days": days,
        "users": {
            "total": await db.users.count_documents({}),
            "new": await db.users.count_documents({"created_at": {"$gte": since}}),
            "active_1d": await active(timedelta(days=1)),
            "active_7d": await active(timedelta(days=7)),
            "active_period": await active(timedelta(days=days)),
            "by_plan": await group("users", {}, "plan_id"),
        },
        "subscriptions": {"by_status": await group("subscriptions", {}, "status"), "mrr_cents": mrr},
        "revenue": {k: revenue.get(k, 0) for k in ("gross", "net", "refunded", "count")},
        "videos": {
            "uploaded": await db.videos.count_documents({"created_at": {"$gte": since}}),
            "jobs": await group("jobs", {"created_at": {"$gte": since}}, "status"),
            "jobs_failed_by_type": await group(
                "jobs", {"created_at": {"$gte": since}, "status": "failed"}, "type"
            ),
            "clips": await db.clips.count_documents({"created_at": {"$gte": since}, "status": "ready"}),
        },
        "publications": {
            "targets": t,
            "failure_rate": round(t.get("failed", 0) / finished, 4) if finished else None,
        },
        "ai": {
            "by_task": {r["_id"]: {"calls": r["calls"], "cost_usd": round(r["cost"], 6)} for r in ai_rows},
            "cost_usd": round(sum(r["cost"] for r in ai_rows), 6),
        },
    }


# ---------------------------------------------------------------- feature flags


class FlagIn(BaseModel):
    enabled: bool = False
    description: Annotated[str, Field(max_length=300)] = ""
    rollout_percent: Annotated[int, Field(ge=0, le=100)] = 100
    plan_ids: Annotated[list[Annotated[str, Field(max_length=30)]], Field(max_length=20)] = []
    user_ids: Annotated[list[Annotated[str, Field(max_length=80)]], Field(max_length=500)] = []


FlagKey = Annotated[str, Field(pattern=r"^[a-z0-9_.-]{2,60}$")]


@router.get("/admin/flags")
async def list_flags(user: Requires("settings:manage"), db: MongoDb) -> dict[str, Any]:
    items = await db.feature_flags.find({}).sort("_id", 1).to_list(500)
    return {"items": [{**_clean({k: v for k, v in f.items() if k != "_id"}), "key": f["_id"]} for f in items]}


@router.put("/admin/flags/{key}")
async def put_flag(
    key: FlagKey, body: FlagIn, actor: Requires("settings:manage"), db: MongoDb
) -> dict[str, Any]:
    before = await db.feature_flags.find_one({"_id": key})
    doc = {**body.model_dump(), "updated_at": _now(), "updated_by": actor.id}
    await db.feature_flags.update_one(
        {"_id": key}, {"$set": doc, "$setOnInsert": {"created_at": _now()}}, upsert=True
    )
    await audit(
        "flag.updated" if before else "flag.created",
        details={"key": key, **body.model_dump(exclude={"user_ids"}), "users": len(body.user_ids)},
    )
    return {"flag": {**_clean(doc), "key": key}}


@router.delete("/admin/flags/{key}")
async def delete_flag(key: str, actor: Requires("settings:manage"), db: MongoDb) -> dict[str, Any]:
    result = await db.feature_flags.delete_one({"_id": key})
    if not result.deleted_count:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Flag não encontrada.")
    await audit("flag.deleted", details={"key": key})
    return {"ok": True}


@router.get("/me/flags")
async def my_flags(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    """Quais funções estão ligadas para a pessoa (a tela usa para mostrar ou esconder)."""
    me = await db.users.find_one({"_id": user.id}, projection={"plan_id": 1})
    return {"flags": await flags.for_user(db, user.id, (me or {}).get("plan_id"))}

"""Fila de jobs no MongoDB, consumida pelo worker.

Estados: queued → running → done | failed | cancelled.

- Um worker pega o próximo job numa operação atômica e recebe um "aluguel" (lease) de 60 s,
  renovado enquanto trabalha. Se o worker cair, o aluguel vence e outro worker retoma o job.
- Cada job guarda em `state` o que já foi feito, para a retomada continuar de onde parou.
- Falha temporária (rede, S3) volta para a fila com espera crescente; falha do arquivo não.
- Cancelar marca o pedido; o worker interrompe o FFmpeg na próxima checagem (a cada poucos segundos).
"""

from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

JobType = Literal[
    "video.transcribe",
    "video.highlights",
    "clip.subtitles",
    "video.ingest",
    "video.split",
    "clip.render",
    "diagnostic.run",
    "publication.publish",
    "asset.process",
    "metrics.collect",
    "webhook.deliver",
]
TERMINAL = ("done", "failed", "cancelled")
PUBLIC_PAYLOAD = ("video_id", "clip_id", "segment_seconds", "publication_id", "count", "preset", "asset_id")

LEASE = timedelta(seconds=60)
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 30


def _now() -> datetime:
    return datetime.now(UTC)


async def enqueue(
    db: AsyncDatabase,
    job_type: JobType,
    user_id: str,
    payload: dict[str, Any],
    *,
    max_attempts: int = MAX_ATTEMPTS,
    job_id: str | None = None,
    run_at: datetime | None = None,
) -> dict[str, Any]:
    """`job_id` fixo deixa o pedido idempotente: o mesmo id duas vezes dá DuplicateKeyError."""
    now = _now()
    job = {
        "_id": job_id or uuid4().hex,
        "type": job_type,
        "user_id": user_id,
        "status": "queued",
        "payload": payload,
        "state": {},
        "progress": 0,
        "message": "Na fila",
        "attempts": 0,
        "max_attempts": max_attempts,
        "run_at": run_at or now,
        "lease_expires_at": None,
        "worker_id": None,
        "cancel_requested": False,
        "error": None,
        "created_at": now,
        "updated_at": now,
        "finished_at": None,
    }
    await db.jobs.insert_one(job)
    return job


async def claim(db: AsyncDatabase, worker_id: str, *, user_id: str | None = None) -> dict[str, Any] | None:
    """Pega o próximo job: um da fila já liberado, ou um que estava rodando num worker que caiu."""
    now = _now()
    query: dict[str, Any] = {
        "$or": [
            {"status": "queued", "run_at": {"$lte": now}},
            {"status": "running", "lease_expires_at": {"$lt": now}},
        ]
    }
    if user_id:
        query["user_id"] = user_id
    return await db.jobs.find_one_and_update(
        query,
        {
            "$set": {
                "status": "running",
                "worker_id": worker_id,
                "lease_expires_at": now + LEASE,
                "updated_at": now,
                "started_at": now,
            },
            "$inc": {"attempts": 1},
        },
        sort=[("run_at", 1)],
        return_document=ReturnDocument.AFTER,
    )


async def requeue(db: AsyncDatabase, job_id: str) -> None:
    """Fim da fatia de tempo: volta para a fila sem contar como tentativa (o estado fica salvo)."""
    now = _now()
    await db.jobs.update_one(
        {"_id": job_id, "status": "running"},
        {
            "$set": {
                "status": "queued",
                "run_at": now,
                "worker_id": None,
                "lease_expires_at": None,
                "updated_at": now,
            },
            "$inc": {"attempts": -1},
        },
    )


async def heartbeat(db: AsyncDatabase, job_id: str, worker_id: str) -> dict[str, Any] | None:
    """Renova o aluguel. Devolve o job (com `cancel_requested`), ou None se outro worker o pegou."""
    now = _now()
    return await db.jobs.find_one_and_update(
        {"_id": job_id, "worker_id": worker_id, "status": "running"},
        {"$set": {"lease_expires_at": now + LEASE, "updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )


async def progress(
    db: AsyncDatabase, job_id: str, percent: float, message: str, state: dict[str, Any] | None = None
) -> None:
    fields: dict[str, Any] = {
        "progress": max(0, min(100, round(percent))),
        "message": message[:200],
        "updated_at": _now(),
    }
    if state is not None:
        fields.update({f"state.{k}": v for k, v in state.items()})
    await db.jobs.update_one({"_id": job_id, "status": "running"}, {"$set": fields})


async def finish(db: AsyncDatabase, job_id: str, message: str, result: dict[str, Any] | None = None) -> None:
    now = _now()
    await db.jobs.update_one(
        {"_id": job_id},
        {
            "$set": {
                "status": "done",
                "progress": 100,
                "message": message,
                "result": result or {},
                "finished_at": now,
                "updated_at": now,
                "lease_expires_at": None,
            }
        },
    )


async def fail(db: AsyncDatabase, job: dict[str, Any], error: str, *, retryable: bool) -> str:
    """Devolve o novo estado: queued (vai tentar de novo) ou failed."""
    now = _now()
    if retryable and job["attempts"] < job["max_attempts"]:
        delay = BACKOFF_BASE_SECONDS * 2 ** (job["attempts"] - 1)
        await db.jobs.update_one(
            {"_id": job["_id"]},
            {
                "$set": {
                    "status": "queued",
                    "run_at": now + timedelta(seconds=delay),
                    "message": f"Falhou, nova tentativa em {delay} s",
                    "error": error[:500],
                    "lease_expires_at": None,
                    "worker_id": None,
                    "updated_at": now,
                }
            },
        )
        return "queued"
    await db.jobs.update_one(
        {"_id": job["_id"]},
        {
            "$set": {
                "status": "failed",
                "message": error[:200],
                "error": error[:500],
                "finished_at": now,
                "lease_expires_at": None,
                "updated_at": now,
            }
        },
    )
    return "failed"


async def mark_cancelled(db: AsyncDatabase, job_id: str) -> None:
    now = _now()
    await db.jobs.update_one(
        {"_id": job_id},
        {
            "$set": {
                "status": "cancelled",
                "message": "Cancelado",
                "finished_at": now,
                "lease_expires_at": None,
                "updated_at": now,
            }
        },
    )


async def request_cancel(db: AsyncDatabase, job_id: str, user_id: str) -> dict[str, Any] | None:
    """Na fila: cancela na hora. Rodando: pede ao worker. Já terminado: não muda nada."""
    job = await db.jobs.find_one_and_update(
        {"_id": job_id, "user_id": user_id, "status": "queued"},
        {
            "$set": {
                "status": "cancelled",
                "message": "Cancelado",
                "finished_at": _now(),
                "updated_at": _now(),
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    if job:
        return job
    return await db.jobs.find_one_and_update(
        {"_id": job_id, "user_id": user_id, "status": "running"},
        {"$set": {"cancel_requested": True, "message": "Cancelando…", "updated_at": _now()}},
        return_document=ReturnDocument.AFTER,
    )


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job["_id"],
        "type": job["type"],
        "status": job["status"],
        "progress": job["progress"],
        "message": job["message"],
        "attempts": job["attempts"],
        "error": job.get("error") if job["status"] == "failed" else None,
        "result": job.get("result", {}),
        "payload": {k: v for k, v in job.get("payload", {}).items() if k in PUBLIC_PAYLOAD},
        "created_at": job["created_at"].isoformat(),
        "updated_at": job["updated_at"].isoformat(),
        "finished_at": job["finished_at"].isoformat() if job.get("finished_at") else None,
    }

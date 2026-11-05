"""Worker na Vercel: sem um processo ligado o tempo todo, a fila anda em fatias.

- POST /api/v1/jobs/pump: a tela chama enquanto há algo processando (e a cada minuto com o Clipo
  aberto). Roda o agendador (no máximo 1x/min) e os jobs do workspace até acabar a fatia de tempo.
- GET /api/v1/internal/cron: tarefa agendada da Vercel (cabeçalho Authorization: Bearer CRON_SECRET).
  Faz a manutenção e avança a fila de todos.

Com um worker de verdade (Docker/Render), as duas rotas não fazem nada.
"""

import hmac
from typing import Any

from fastapi import APIRouter, Request, status

from clipo_api.core.config import get_settings
from clipo_api.core.errors import ApiError
from clipo_api.core.ratelimit import hit
from clipo_api.core.workspace import WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import record

router = APIRouter(prefix="/api/v1", tags=["worker"])


@router.post("/jobs/pump")
async def pump(ws: WsUser, db: MongoDb) -> dict[str, Any]:
    settings = get_settings()
    if not settings.is_serverless:
        return {"mode": "worker", "ran": 0}
    from clipo_api.worker import run_slice, scheduler_tick_throttled

    await hit(db, "pump:user", ws.actor_id, limit=60, window_seconds=60)
    await scheduler_tick_throttled(db)
    out = await run_slice(db, budget=settings.worker_budget_seconds, user_id=ws.id)
    active = await db.jobs.count_documents({"user_id": ws.id, "status": {"$in": ["queued", "running"]}})
    return {"mode": "serverless", **out, "active": active}


@router.get("/internal/cron", include_in_schema=False)
async def cron(request: Request, db: MongoDb) -> dict[str, Any]:
    settings = get_settings()
    expected = f"Bearer {settings.cron_secret}" if settings.cron_secret else None
    given = request.headers.get("authorization", "")
    if not expected or not hmac.compare_digest(given, expected):
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Tarefa agendada sem autorização.")
    if not settings.is_serverless:
        return {"mode": "worker", "ran": 0}
    from clipo_api.worker import maintenance, run_slice, scheduler_tick_throttled

    await scheduler_tick_throttled(db, every_seconds=0)
    await maintenance(db, "vercel-cron")
    out = await run_slice(db, budget=settings.worker_budget_seconds)
    await record("job", "cron.tick", f"Tarefa agendada: {out['ran']} job(s) processado(s)")
    return {"mode": "serverless", **out}

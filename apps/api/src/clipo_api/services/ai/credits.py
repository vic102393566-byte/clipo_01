"""Créditos de IA por plano (por mês) e teto de gasto diário da plataforma.

Os créditos são reservados antes de começar e devolvidos se a tarefa falhar. A reserva é atômica:
dois pedidos ao mesmo tempo não passam juntos do limite.
"""

from datetime import UTC, datetime
from typing import Any

from fastapi import status
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from clipo_api.core.errors import ApiError
from clipo_api.core.plans import get_plan
from clipo_api.observability.logs import record


def _month(now: datetime | None = None) -> str:
    return f"{now or datetime.now(UTC):%Y-%m}"


def _day(now: datetime | None = None) -> str:
    return f"{now or datetime.now(UTC):%Y-%m-%d}"


async def _limit(db: AsyncDatabase, user_id: str) -> tuple[int, str]:
    user = await db.users.find_one({"_id": user_id}, projection={"plan_id": 1})
    plan = await get_plan(db, (user or {}).get("plan_id"))
    # Créditos extras dados pelo admin valem só no mês em que foram dados.
    doc = await db.ai_usage.find_one({"_id": f"{user_id}:{_month()}"}, projection={"bonus": 1}) or {}
    return plan.ai_credits_month + int(doc.get("bonus", 0)), plan.name


async def grant_bonus(db: AsyncDatabase, user_id: str, amount: int) -> dict[str, Any]:
    await db.ai_usage.update_one(
        {"_id": f"{user_id}:{_month()}"},
        {"$inc": {"bonus": amount}, "$setOnInsert": {"user_id": user_id, "month": _month(), "used": 0}},
        upsert=True,
    )
    return await usage(db, user_id)


async def usage(db: AsyncDatabase, user_id: str) -> dict[str, Any]:
    limit, plan_name = await _limit(db, user_id)
    doc = await db.ai_usage.find_one({"_id": f"{user_id}:{_month()}"}) or {}
    used = doc.get("used", 0)
    return {
        "month": _month(),
        "used": used,
        "limit": limit,
        "remaining": max(0, limit - used),
        "plan": plan_name,
    }


async def reserve(db: AsyncDatabase, user_id: str, amount: int, reason: str) -> int:
    """Levanta 402 se não houver crédito. Devolve quanto foi reservado."""
    if amount <= 0:
        return 0
    limit, plan_name = await _limit(db, user_id)
    key = f"{user_id}:{_month()}"
    try:
        await db.ai_usage.update_one(
            {"_id": key}, {"$setOnInsert": {"user_id": user_id, "month": _month(), "used": 0}}, upsert=True
        )
    except DuplicateKeyError:
        pass
    taken = await db.ai_usage.find_one_and_update(
        {"_id": key, "used": {"$lte": limit - amount}}, {"$inc": {"used": amount}}
    )
    if taken is None:
        current = await usage(db, user_id)
        await record(
            "ai",
            "credits.exhausted",
            f"Sem créditos de IA para {reason}",
            level="warning",
            outcome="denied",
            user_id=user_id,
            details={"needed": amount, **current},
        )
        raise ApiError(
            status.HTTP_402_PAYMENT_REQUIRED,
            "ai_credits_exhausted",
            f"Isso usa {amount} crédito(s) de IA e restam {current['remaining']} de {limit} "
            f"no plano {plan_name} este mês.",
        )
    return amount


async def refund(db: AsyncDatabase, user_id: str, amount: int, month: str | None = None) -> None:
    if amount > 0:
        await db.ai_usage.update_one({"_id": f"{user_id}:{month or _month()}"}, {"$inc": {"used": -amount}})


# ---------------------------------------------------------------- teto diário (plataforma)


async def spent_today(db: AsyncDatabase) -> float:
    doc = await db.ai_spend.find_one({"_id": _day()}) or {}
    return float(doc.get("usd", 0))


async def add_spend(db: AsyncDatabase, usd: float | None, budget: float) -> None:
    if not usd:
        return
    doc = await db.ai_spend.find_one_and_update(
        {"_id": _day()}, {"$inc": {"usd": usd, "calls": 1}}, upsert=True, return_document=True
    )
    if doc["usd"] >= 0.8 * budget and not doc.get("alerted_80"):
        claimed = await db.ai_spend.find_one_and_update(
            {"_id": _day(), "alerted_80": {"$ne": True}}, {"$set": {"alerted_80": True}}
        )
        if claimed:
            await record(
                "ai",
                "budget.warning",
                f"Gasto de IA hoje passou de 80% do teto (US$ {doc['usd']:.2f} de {budget:.2f})",
                level="warning",
                details={"usd": doc["usd"], "budget": budget},
            )

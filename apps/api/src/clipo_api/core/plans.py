"""Planos: limites e preços, guardados no banco e editáveis pelo admin.

Os valores abaixo são só o ponto de partida (gravados na primeira subida). Depois disso vale o
que está na coleção `plans`. Cada processo guarda os planos em memória por 30 s.

"gratis" é o plano de reserva: quem não paga (teste acabou, cancelou, inadimplente depois do
prazo) cai nele. Não é vendido; o admin pode mudar os limites dele.
"""

import time
from dataclasses import asdict, dataclass, field, fields
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

GB = 1024**3
MB = 1024**2
CACHE_SECONDS = 30


@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    storage_bytes: int
    max_file_bytes: int
    max_duration_seconds: int
    videos_per_month: int
    social_accounts: int
    # Preços em centavos de real. 0 = sem cobrança.
    price_monthly_cents: int = 0
    price_yearly_cents: int = 0
    ai_credits_month: int = 0
    # Pessoas no workspace, contando o dono.
    team_seats: int = 1
    # Vendido (aparece na tela de planos e aceita checkout).
    public: bool = True
    active: bool = True
    order: int = 0
    features: tuple[str, ...] = field(default_factory=tuple)

    def price_cents(self, cycle: str) -> int:
        return self.price_yearly_cents if cycle == "yearly" else self.price_monthly_cents

    def as_doc(self) -> dict[str, Any]:
        doc = asdict(self)
        doc["_id"] = doc.pop("id")
        doc["features"] = list(self.features)
        return doc

    @classmethod
    def from_doc(cls, doc: dict[str, Any]) -> "Plan":
        known = {f.name for f in fields(cls)}
        values = {k: v for k, v in doc.items() if k in known}
        values["id"] = doc["_id"]
        values["features"] = tuple(doc.get("features") or ())
        return cls(**values)


FREE_PLAN_ID = "gratis"

DEFAULT_PLANS: dict[str, Plan] = {
    "gratis": Plan(
        "gratis",
        "Gratuito",
        1 * GB,
        500 * MB,
        10 * 60,
        5,
        1,
        ai_credits_month=10,
        public=False,
        order=0,
        features=("1 conta social", "1 GB de espaço", "Vídeos de até 10 minutos", "5 vídeos por mês"),
    ),
    "basico": Plan(
        "basico",
        "Básico",
        5 * GB,
        2 * GB,
        30 * 60,
        30,
        1,
        price_monthly_cents=2990,
        price_yearly_cents=29900,
        ai_credits_month=100,
        order=1,
        features=(
            "1 conta social conectada",
            "5 GB de armazenamento total",
            "Vídeos de até 30 minutos",
            "Até 30 vídeos/mês",
            "Corte automático inteligente",
            "Agendamento de publicações",
        ),
    ),
    "pro": Plan(
        "pro",
        "Pro",
        50 * GB,
        10 * GB,
        2 * 3600,
        150,
        3,
        price_monthly_cents=5990,
        price_yearly_cents=59900,
        ai_credits_month=500,
        team_seats=3,
        order=2,
        features=(
            "Até 3 contas sociais conectadas",
            "50 GB de armazenamento total",
            "Vídeos longos de até 2 horas",
            "Arquivos de até 10 GB por vídeo",
            "Até 150 vídeos/mês",
            "Agendamento multicanal simultâneo",
        ),
    ),
    "premium": Plan(
        "premium",
        "Premium",
        200 * GB,
        25 * GB,
        4 * 3600,
        500,
        3,
        price_monthly_cents=9990,
        price_yearly_cents=99900,
        ai_credits_month=2000,
        team_seats=10,
        order=3,
        features=(
            "Até 3 contas sociais conectadas",
            "200 GB de armazenamento total",
            "Vídeos de até 4 horas",
            "Arquivos de até 25 GB por vídeo",
            "Até 500 vídeos/mês",
            "Agendamento prioritário",
        ),
    ),
}

_cache: dict[str, Plan] = {}
_loaded_at = 0.0


async def seed(db: AsyncDatabase) -> None:
    """Grava os planos padrão que ainda não existem (nunca sobrescreve o que o admin mudou)."""
    for plan in DEFAULT_PLANS.values():
        await db.plans.update_one({"_id": plan.id}, {"$setOnInsert": plan.as_doc()}, upsert=True)
        # Campos novos entram nos planos que já existiam sem tocar no resto.
        await db.plans.update_one(
            {"_id": plan.id, "team_seats": {"$exists": False}}, {"$set": {"team_seats": plan.team_seats}}
        )
    invalidate()


def invalidate() -> None:
    global _loaded_at
    _loaded_at = 0.0


async def all_plans(db: AsyncDatabase) -> dict[str, Plan]:
    global _cache, _loaded_at
    if time.monotonic() - _loaded_at > CACHE_SECONDS or not _cache:
        docs = await db.plans.find({}).to_list()
        _cache = {d["_id"]: Plan.from_doc(d) for d in docs} or dict(DEFAULT_PLANS)
        _loaded_at = time.monotonic()
    return _cache


async def get_plan(db: AsyncDatabase, plan_id: str | None) -> Plan:
    plans = await all_plans(db)
    return plans.get(plan_id or "") or plans.get(FREE_PLAN_ID) or DEFAULT_PLANS[FREE_PLAN_ID]


def public_plan(plan: Plan) -> dict[str, Any]:
    return {
        "id": plan.id,
        "name": plan.name,
        "price_monthly_cents": plan.price_monthly_cents,
        "price_yearly_cents": plan.price_yearly_cents,
        "storage_bytes": plan.storage_bytes,
        "max_file_bytes": plan.max_file_bytes,
        "max_duration_seconds": plan.max_duration_seconds,
        "videos_per_month": plan.videos_per_month,
        "social_accounts": plan.social_accounts,
        "ai_credits_month": plan.ai_credits_month,
        "features": list(plan.features),
        "public": plan.public,
        "active": plan.active,
        "order": plan.order,
    }

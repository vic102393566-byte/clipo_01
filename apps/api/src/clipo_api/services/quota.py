"""Uso e cotas por plano: espaço, tamanho por arquivo, duração e vídeos por mês.

O espaço usado soma o que já está guardado (originais, prévias, miniaturas e cortes, inclusive na
lixeira até a exclusão definitiva) mais o que está sendo enviado agora, para dois envios ao mesmo
tempo não passarem juntos do limite.
"""

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import status
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.errors import ApiError
from clipo_api.core.plans import Plan, get_plan


@dataclass(frozen=True)
class Usage:
    plan_id: str
    storage_used_bytes: int
    storage_limit_bytes: int
    uploading_bytes: int
    videos_this_month: int
    videos_per_month: int
    max_file_bytes: int
    max_duration_seconds: int

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


async def _sum(db: AsyncDatabase, collection: str, match: dict[str, Any], fields: list[str]) -> int:
    total = {"$add": [{"$ifNull": [f"${f}", 0]} for f in fields]}
    rows = await (
        await db[collection].aggregate(
            [{"$match": match}, {"$group": {"_id": None, "bytes": {"$sum": total}}}]
        )
    ).to_list()
    return int(rows[0]["bytes"]) if rows else 0


def month_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def usage(db: AsyncDatabase, user_id: str) -> Usage:
    user = await db.users.find_one({"_id": user_id}, projection={"plan_id": 1})
    plan: Plan = await get_plan(db, (user or {}).get("plan_id"))
    stored = (
        await _sum(db, "videos", {"user_id": user_id}, ["source_size", "preview_size", "thumb_size"])
        + await _sum(db, "clips", {"user_id": user_id}, ["size", "thumb_size", "subtitled_size"])
        + await _sum(db, "assets", {"user_id": user_id}, ["size_bytes", "thumb_size"])
    )
    uploading = await _sum(db, "uploads", {"user_id": user_id, "status": "uploading"}, ["size_bytes"])
    this_month = await db.videos.count_documents(
        {"user_id": user_id, "created_at": {"$gte": month_start()}, "status": {"$ne": "rejected"}}
    )
    return Usage(
        plan_id=plan.id,
        storage_used_bytes=stored,
        storage_limit_bytes=plan.storage_bytes,
        uploading_bytes=uploading,
        videos_this_month=this_month,
        videos_per_month=plan.videos_per_month,
        max_file_bytes=plan.max_file_bytes,
        max_duration_seconds=plan.max_duration_seconds,
    )


def _gb(n: int) -> str:
    return f"{n / 1024**3:.1f}".replace(".", ",").replace(",0", "") + " GB"


async def check_new_upload(db: AsyncDatabase, user_id: str, size_bytes: int) -> Usage:
    """Levanta 403 com o motivo se o envio passar de algum limite do plano."""
    current = await usage(db, user_id)
    plan = await get_plan(db, current.plan_id)
    if size_bytes > current.max_file_bytes:
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "quota_file_size",
            f"O plano {plan.name} aceita arquivos de até {_gb(current.max_file_bytes)}.",
        )
    if current.videos_this_month >= current.videos_per_month:
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "quota_monthly_videos",
            f"Você já enviou {current.videos_this_month} vídeos este mês, o limite do plano {plan.name}.",
        )
    if current.storage_used_bytes + current.uploading_bytes + size_bytes > current.storage_limit_bytes:
        free = max(0, current.storage_limit_bytes - current.storage_used_bytes - current.uploading_bytes)
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "quota_storage",
            f"Espaço insuficiente: restam {_gb(free)} dos {_gb(current.storage_limit_bytes)} "
            f"do plano {plan.name}.",
        )
    return current


async def check_new_render(db: AsyncDatabase, user_id: str, estimated_bytes: int) -> None:
    """Cortes também ocupam espaço: não começa um corte que já sabemos que não cabe."""
    current = await usage(db, user_id)
    if current.storage_used_bytes + current.uploading_bytes + estimated_bytes > current.storage_limit_bytes:
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "quota_storage",
            "Espaço insuficiente para gerar os cortes. Libere espaço ou mude de plano.",
        )

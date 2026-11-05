"""Consulta dos logs do sistema e da auditoria (primeira rota da API v1).

- Logs do sistema: suporte, admin e super admin.
- Auditoria: só admin e super admin.

Paginação por cursor (estável mesmo com logs chegando o tempo todo) e exportação em CSV.
Consultar ou exportar logs também fica registrado na auditoria.
"""

import base64
import csv
import io
import json
import re
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from clipo_api.core.errors import ApiError
from clipo_api.core.permissions import Requires
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import CATEGORIES, LEVELS, Category, Level, audit

router = APIRouter(prefix="/api/v1/admin", tags=["admin · logs"])

LogReader = Requires("logs:read")
AuditReader = Requires("audit:read")

MAX_PAGE = 200
MAX_EXPORT = 50_000


def _encode_cursor(doc: dict[str, Any]) -> str:
    raw = json.dumps([doc["created_at"].isoformat(), doc["_id"]]).encode()
    return base64.urlsafe_b64encode(raw).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        created, doc_id = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return datetime.fromisoformat(created), str(doc_id)
    except (ValueError, TypeError) as exc:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST, "invalid_cursor", "Cursor de paginação inválido."
        ) from exc


def _after_cursor(cursor: str | None) -> dict[str, Any]:
    if not cursor:
        return {}
    created, doc_id = _decode_cursor(cursor)
    return {"$or": [{"created_at": {"$lt": created}}, {"created_at": created, "_id": {"$lt": doc_id}}]}


def _period(date_from: datetime | None, date_to: datetime | None) -> dict[str, Any]:
    rng: dict[str, Any] = {}
    if date_from:
        rng["$gte"] = date_from if date_from.tzinfo else date_from.replace(tzinfo=UTC)
    if date_to:
        rng["$lte"] = date_to if date_to.tzinfo else date_to.replace(tzinfo=UTC)
    return {"created_at": rng} if rng else {}


class LogFilters(BaseModel):
    date_from: datetime | None = None
    date_to: datetime | None = None
    level: list[Level] = []
    category: list[Category] = []
    event: str | None = None
    outcome: str | None = None
    user_id: str | None = None
    platform: str | None = None
    request_id: str | None = None
    q: str | None = None

    def to_query(self) -> dict[str, Any]:
        query: dict[str, Any] = _period(self.date_from, self.date_to)
        if self.level:
            query["level"] = {"$in": self.level}
        if self.category:
            query["category"] = {"$in": self.category}
        if self.event:
            # Prefixo: "login" acha login.success e login.failed.
            query["event"] = {"$regex": f"^{re.escape(self.event)}"}
        for field in ("outcome", "user_id", "platform", "request_id"):
            if value := getattr(self, field):
                query[field] = value
        if self.q:
            query["message"] = {"$regex": re.escape(self.q), "$options": "i"}
        return query


def _filters(
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    level: Annotated[list[Level] | None, Query()] = None,
    category: Annotated[list[Category] | None, Query()] = None,
    event: Annotated[str | None, Query(max_length=100)] = None,
    outcome: Annotated[str | None, Query(pattern="^(success|failure|denied)$")] = None,
    user_id: Annotated[str | None, Query(max_length=64)] = None,
    platform: Annotated[str | None, Query(max_length=40)] = None,
    request_id: Annotated[str | None, Query(max_length=64)] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
) -> LogFilters:
    return LogFilters(
        date_from=date_from,
        date_to=date_to,
        level=level or [],
        category=category or [],
        event=event,
        outcome=outcome,
        user_id=user_id,
        platform=platform,
        request_id=request_id,
        q=q,
    )


Filters = Annotated[LogFilters, Depends(_filters)]


def _log_out(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": doc["_id"],
        "created_at": doc["created_at"].isoformat(),
        "level": doc["level"],
        "category": doc["category"],
        "event": doc["event"],
        "message": doc["message"],
        "outcome": doc.get("outcome"),
        "user_id": doc.get("user_id"),
        "platform": doc.get("platform"),
        "request_id": doc.get("request_id"),
        "duration_ms": doc.get("duration_ms"),
        "details": doc.get("details", {}),
    }


@router.get("/logs")
async def list_logs(
    user: LogReader,
    db: MongoDb,
    filters: Filters,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
) -> dict[str, Any]:
    query = {**filters.to_query(), **_after_cursor(cursor)}
    docs = await db.system_logs.find(query).sort([("created_at", -1), ("_id", -1)]).limit(limit + 1).to_list()
    has_more = len(docs) > limit
    docs = docs[:limit]
    return {
        "items": [_log_out(d) for d in docs],
        "next_cursor": _encode_cursor(docs[-1]) if has_more else None,
        "filters": {"levels": list(LEVELS), "categories": list(CATEGORIES)},
    }


@router.get("/logs/summary")
async def logs_summary(user: LogReader, db: MongoDb, filters: Filters) -> dict[str, Any]:
    """Totais por nível e por categoria no período: base dos painéis de erro do admin."""
    rows = await (
        await db.system_logs.aggregate(
            [
                {"$match": filters.to_query()},
                {"$group": {"_id": {"category": "$category", "level": "$level"}, "count": {"$sum": 1}}},
            ]
        )
    ).to_list()
    summary: dict[str, dict[str, int]] = {}
    for row in rows:
        summary.setdefault(row["_id"]["category"], {})[row["_id"]["level"]] = row["count"]
    return {"by_category": summary, "total": sum(r["count"] for r in rows)}


@router.get("/logs/integrations")
async def integration_errors(
    user: LogReader, db: MongoDb, hours: Annotated[int, Query(ge=1, le=24 * 30)] = 24
) -> dict[str, Any]:
    """Painel de erros por integração: totais, eventos que mais falham e a série por hora."""
    since = datetime.now(UTC) - timedelta(hours=hours)
    match = {
        "created_at": {"$gte": since},
        "category": {"$in": ["integration", "webhook", "payment", "ai", "publication"]},
        "platform": {"$ne": None},
    }
    totals = await (
        await db.system_logs.aggregate(
            [
                {"$match": match},
                {
                    "$group": {
                        "_id": "$platform",
                        "total": {"$sum": 1},
                        "errors": {"$sum": {"$cond": [{"$eq": ["$level", "error"]}, 1, 0]}},
                        "warnings": {"$sum": {"$cond": [{"$eq": ["$level", "warning"]}, 1, 0]}},
                    }
                },
            ]
        )
    ).to_list()
    top = await (
        await db.system_logs.aggregate(
            [
                {"$match": {**match, "level": "error"}},
                {"$sort": {"created_at": -1}},
                {
                    "$group": {
                        "_id": {"platform": "$platform", "event": "$event"},
                        "count": {"$sum": 1},
                        "last_message": {"$first": "$message"},
                        "last_at": {"$first": "$created_at"},
                    }
                },
                {"$sort": {"count": -1}},
                {"$limit": 50},
            ]
        )
    ).to_list()
    series = await (
        await db.system_logs.aggregate(
            [
                {"$match": {**match, "level": "error"}},
                {
                    "$group": {
                        "_id": {
                            "platform": "$platform",
                            "hour": {"$dateTrunc": {"date": "$created_at", "unit": "hour"}},
                        },
                        "count": {"$sum": 1},
                    }
                },
                {"$sort": {"_id.hour": 1}},
            ]
        )
    ).to_list()
    platforms: dict[str, Any] = {}
    for row in totals:
        rate = row["errors"] / row["total"] if row["total"] else 0
        platforms[row["_id"]] = {
            **{k: row[k] for k in ("total", "errors", "warnings")},
            "error_rate": round(rate, 4),
        }
    return {
        "hours": hours,
        "platforms": platforms,
        "top_errors": [
            {
                **r["_id"],
                "count": r["count"],
                "last_message": r["last_message"],
                "last_at": r["last_at"].isoformat(),
            }
            for r in top
        ],
        "series": [
            {"platform": r["_id"]["platform"], "hour": r["_id"]["hour"].isoformat(), "errors": r["count"]}
            for r in series
        ],
    }


CSV_FIELDS = [
    "created_at",
    "level",
    "category",
    "event",
    "outcome",
    "message",
    "user_id",
    "platform",
    "request_id",
    "duration_ms",
    "details",
]


@router.get("/logs/export.csv")
async def export_logs(user: LogReader, db: MongoDb, filters: Filters) -> StreamingResponse:
    query = filters.to_query()
    await audit("logs.exported", details={"filters": filters.model_dump(mode="json", exclude_none=True)})

    async def rows() -> AsyncIterator[str]:
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=CSV_FIELDS)
        writer.writeheader()
        cursor = db.system_logs.find(query).sort([("created_at", -1), ("_id", -1)]).limit(MAX_EXPORT)
        async for doc in cursor:
            item = _log_out(doc)
            item["details"] = json.dumps(item["details"], ensure_ascii=False)
            # Evita fórmula no Excel (=, +, -, @ no começo da célula).
            for key in ("message", "details", "event"):
                if str(item[key]).startswith(("=", "+", "-", "@")):
                    item[key] = "'" + str(item[key])
            writer.writerow({k: item.get(k) for k in CSV_FIELDS})
            if buffer.tell() > 64_000:
                yield buffer.getvalue()
                buffer.seek(0)
                buffer.truncate()
        yield buffer.getvalue()

    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M")
    return StreamingResponse(
        rows(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="clipo-logs-{stamp}.csv"'},
    )


@router.get("/audit")
async def list_audit(
    user: AuditReader,
    db: MongoDb,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    action: Annotated[str | None, Query(max_length=100)] = None,
    actor_id: Annotated[str | None, Query(max_length=64)] = None,
    target_user_id: Annotated[str | None, Query(max_length=64)] = None,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
) -> dict[str, Any]:
    query: dict[str, Any] = _period(date_from, date_to)
    if action:
        query["action"] = {"$regex": f"^{re.escape(action)}"}
    if actor_id:
        query["actor_id"] = actor_id
    if target_user_id:
        query["target_user_id"] = target_user_id
    query.update(_after_cursor(cursor))
    docs = await db.audit_logs.find(query).sort([("created_at", -1), ("_id", -1)]).limit(limit + 1).to_list()
    has_more = len(docs) > limit
    docs = docs[:limit]
    return {
        "items": [
            {
                "id": d["_id"],
                "created_at": d["created_at"].isoformat(),
                "action": d["action"],
                "actor_id": d.get("actor_id"),
                "target_user_id": d.get("target_user_id"),
                "request_id": d.get("request_id"),
                "details": d.get("details", {}),
            }
            for d in docs
        ],
        "next_cursor": _encode_cursor(docs[-1]) if has_more else None,
    }

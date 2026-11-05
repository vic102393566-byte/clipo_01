"""Métricas das publicações: coleta nas redes, simulador local e os números das telas.

Coleta: a cada minuto o agendador pega até 25 publicações publicadas nos últimos 90 dias que estão
há 6 h sem coleta. Cada rede devolve os totais acumulados; gravamos uma foto por dia em `metrics`
com o total e o quanto cresceu desde o dia anterior (é o que somamos por período).

Simulador: fora de produção (ou com METRICS_SIMULATOR=true), publicação sem conexão de verdade ou
rede que não informa métricas recebe números gerados por uma curva fixa (mesma publicação, mesmo
dia, mesmo número). Tudo o que é simulado sai marcado com `simulated: true` para a tela avisar.
"""

import hashlib
import math
import re
import unicodedata
from datetime import UTC, datetime, timedelta
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.config import get_settings
from clipo_api.observability.logs import record
from clipo_api.services import connections, connectors
from clipo_api.services.connectors.base import ConnectorError, NotSupported, PostMetrics

COLLECT_EVERY = timedelta(hours=6)
FOLLOWERS_EVERY = timedelta(hours=12)
WINDOW = timedelta(days=90)
BATCH = 25
FIELDS = ("views", "likes", "comments", "shares", "saves")
PERIODS = {"7d": 7, "30d": 30, "90d": 90, "year": 365}
PLATFORM_WEIGHT = {"tiktok": 1.6, "instagram": 1.0, "youtube": 0.8, "linkedin": 0.25}


def _now() -> datetime:
    return datetime.now(UTC)


def _day(when: datetime) -> str:
    return when.strftime("%Y-%m-%d")


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def simulator_on() -> bool:
    s = get_settings()
    return s.metrics_simulator if s.metrics_simulator is not None else not s.is_production


# ---------------------------------------------------------------- simulador


def _seed(*parts: str) -> float:
    """Número fixo entre 0 e 1 para a mesma entrada."""
    digest = hashlib.sha256(":".join(parts).encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def simulate(
    key: str, platform: str, published_at: datetime, at: datetime, duration_s: float = 45
) -> PostMetrics:
    """Curva de crescimento que satura em ~10 dias, com tamanho e engajamento sorteados por publicação."""
    age_days = max(0.0, (_utc(at) - _utc(published_at)).total_seconds() / 86400)
    reach = 600 + _seed(key, platform, "reach") ** 2.2 * 140_000
    views = int(reach * PLATFORM_WEIGHT.get(platform, 1.0) * (1 - math.exp(-age_days / 2.8)))
    like_rate = 0.04 + _seed(key, platform, "likes") * 0.08
    retention = 32 + _seed(key, platform, "retention") * 46
    return PostMetrics(
        views=views,
        likes=int(views * like_rate),
        comments=int(views * like_rate * 0.09),
        shares=int(views * (0.006 + _seed(key, platform, "shares") * 0.02)),
        saves=int(views * (0.004 + _seed(key, platform, "saves") * 0.018)),
        avg_view_s=round(duration_s * retention / 100, 1),
        retention_pct=round(retention, 1),
    )


def simulate_followers(user_id: str, platform: str, at: datetime) -> int:
    base = 400 + _seed(user_id, platform, "base") ** 1.6 * 90_000 * PLATFORM_WEIGHT.get(platform, 1.0)
    daily = 0.002 + _seed(user_id, platform, "growth") * 0.006
    days = (_utc(at) - datetime(2026, 1, 1, tzinfo=UTC)).days
    return int(base * (1 + daily) ** max(days, 0))


def retention_curve(retention_pct: float) -> list[float]:
    """Curva de 10 pontos (0%, 10%... 90% do vídeo) com a queda típica dos primeiros segundos."""
    end = max(5.0, retention_pct * 0.72)
    return [round(end + (100 - end) * math.exp(-i / 2.4), 1) for i in range(10)]


# ---------------------------------------------------------------- coleta


async def store(
    db: AsyncDatabase,
    pub: dict[str, Any],
    platform: str,
    snap: PostMetrics,
    at: datetime,
    *,
    simulated: bool,
    demo: bool = False,
) -> None:
    """Grava a foto do dia com o total e o crescimento desde o dia anterior (idempotente no mesmo dia)."""
    day = _day(at)
    prev = await db.metrics.find_one(
        {"publication_id": pub["_id"], "platform": platform, "day": {"$lt": day}}, sort=[("day", -1)]
    )
    totals = {f: int(getattr(snap, f) or 0) for f in FIELDS}
    deltas = {f"{f}_delta": max(0, totals[f] - int((prev or {}).get(f, 0))) for f in FIELDS}
    await db.metrics.update_one(
        {"publication_id": pub["_id"], "platform": platform, "day": day},
        {
            "$set": {
                "user_id": pub["user_id"],
                "title": pub["title"],
                "source": pub["source"],
                "published_at": pub.get("published_at"),
                **totals,
                **deltas,
                "avg_view_s": snap.avg_view_s,
                "retention_pct": snap.retention_pct,
                "simulated": simulated,
                "demo": demo,
                "collected_at": at,
            }
        },
        upsert=True,
    )


async def _fetch(
    db: AsyncDatabase, pub: dict[str, Any], target: dict[str, Any], at: datetime
) -> tuple[PostMetrics, bool] | None:
    platform = target["platform"]
    connector = connectors.get(platform)
    remote_id = target.get("remote_id")
    if connector and connector.configured() and remote_id and not pub.get("demo"):
        try:
            conn, tokens = await connections.access(db, pub["user_id"], platform)
            return await connector.metrics(tokens, conn["account"], remote_id), False
        except NotSupported:
            pass
        except ConnectorError as exc:
            await record(
                "analytics",
                "metrics.failed",
                f"Métricas do {connector.label}: {exc.message}",
                level="warning",
                outcome="failure",
                user_id=pub["user_id"],
                platform=platform,
                details={"publication_id": pub["_id"], "code": exc.code},
            )
            if not simulator_on():
                return None
    if not simulator_on():
        return None
    published = target.get("published_at") or pub.get("published_at") or pub["created_at"]
    return simulate(pub["_id"], platform, published, at, pub.get("duration_s") or 45), True


async def collect_due(db: AsyncDatabase, now: datetime | None = None) -> int:
    now = now or _now()
    query = {
        "status": {"$in": ["published", "partial"]},
        "published_at": {"$gte": now - WINDOW},
        "$or": [
            {"metrics_next_at": None},
            {"metrics_next_at": {"$exists": False}},
            {"metrics_next_at": {"$lte": now}},
        ],
    }
    done = 0
    async for pub in db.publications.find(query).limit(BATCH):
        # Marca antes de coletar: dois agendadores ao mesmo tempo não repetem a mesma publicação.
        claimed = await db.publications.find_one_and_update(
            {"_id": pub["_id"], "metrics_next_at": pub.get("metrics_next_at")},
            {"$set": {"metrics_next_at": now + COLLECT_EVERY}},
        )
        if claimed is None:
            continue
        for target in pub["targets"]:
            if target.get("status") != "published":
                continue
            got = await _fetch(db, pub, target, now)
            if got:
                await store(db, pub, target["platform"], got[0], now, simulated=got[1])
        done += 1
    await collect_followers(db, now)
    return done


async def collect_followers(db: AsyncDatabase, now: datetime | None = None) -> None:
    now = now or _now()
    query = {
        "status": "active",
        "$or": [{"followers_next_at": {"$exists": False}}, {"followers_next_at": {"$lte": now}}],
    }
    async for conn in db.connections.find(query).limit(BATCH):
        await db.connections.update_one(
            {"_id": conn["_id"]}, {"$set": {"followers_next_at": now + FOLLOWERS_EVERY}}
        )
        platform, user_id = conn["platform"], conn["user_id"]
        simulated = False
        try:
            _, tokens = await connections.access(db, user_id, platform)
            count = await connectors.get(platform).followers(tokens, conn["account"])
        except ConnectorError:
            if not simulator_on():
                continue
            count, simulated = simulate_followers(user_id, platform, now), True
        await save_followers(db, user_id, platform, count, now, simulated=simulated)


async def save_followers(
    db: AsyncDatabase,
    user_id: str,
    platform: str,
    count: int,
    at: datetime,
    *,
    simulated: bool,
    demo: bool = False,
) -> None:
    await db.follower_snapshots.update_one(
        {"user_id": user_id, "platform": platform, "day": _day(at)},
        {"$set": {"followers": count, "simulated": simulated, "demo": demo, "collected_at": at}},
        upsert=True,
    )


# ---------------------------------------------------------------- leitura


def _match(
    user_id: str, days: int, platform: str | None, *, offset: int = 0, now: datetime | None = None
) -> dict:
    end = (now or _now()) - timedelta(days=offset)
    start = end - timedelta(days=days)
    query: dict[str, Any] = {"user_id": user_id, "day": {"$gt": _day(start), "$lte": _day(end)}}
    if platform:
        query["platform"] = platform
    return query


async def _sums(db: AsyncDatabase, match: dict[str, Any]) -> dict[str, Any]:
    group: dict[str, Any] = {"_id": None, **{f: {"$sum": f"${f}_delta"} for f in FIELDS}}
    rows = await (await db.metrics.aggregate([{"$match": match}, {"$group": group}])).to_list()
    return rows[0] if rows else dict.fromkeys(FIELDS, 0)


async def _latest_per_target(db: AsyncDatabase, match: dict[str, Any]) -> list[dict[str, Any]]:
    """Última foto de cada publicação/rede no período."""
    pipeline = [
        {"$match": match},
        {"$sort": {"day": -1}},
        {"$group": {"_id": {"p": "$publication_id", "n": "$platform"}, "doc": {"$first": "$$ROOT"}}},
        {"$replaceRoot": {"newRoot": "$doc"}},
    ]
    return await (await db.metrics.aggregate(pipeline)).to_list()


def _delta_pct(now_value: float, before: float) -> float | None:
    if not before:
        return None
    return round((now_value - before) / before * 100, 1)


def _weighted_retention(rows: list[dict[str, Any]]) -> float | None:
    rated = [(r["retention_pct"], r.get("views") or 0) for r in rows if r.get("retention_pct") is not None]
    weight = sum(v for _, v in rated)
    if not rated:
        return None
    if not weight:
        return round(sum(r for r, _ in rated) / len(rated), 1)
    return round(sum(r * v for r, v in rated) / weight, 1)


async def _new_followers(
    db: AsyncDatabase, user_id: str, days: int, platform: str | None, offset: int = 0
) -> int:
    end = _now() - timedelta(days=offset)
    start = end - timedelta(days=days)
    query: dict[str, Any] = {"user_id": user_id}
    if platform:
        query["platform"] = platform
    total = 0
    for net in await db.follower_snapshots.distinct("platform", query):
        q = {"user_id": user_id, "platform": net}
        last = await db.follower_snapshots.find_one(q | {"day": {"$lte": _day(end)}}, sort=[("day", -1)])
        first = await db.follower_snapshots.find_one(q | {"day": {"$lte": _day(start)}}, sort=[("day", -1)])
        first = first or await db.follower_snapshots.find_one(
            q | {"day": {"$gt": _day(start)}}, sort=[("day", 1)]
        )
        if last and first:
            total += max(0, last["followers"] - first["followers"])
    return total


def thumb_url(source: dict[str, Any]) -> str:
    kind = "videos" if source.get("kind") == "video" else "clips"
    return f"/api/v1/{kind}/{source.get('id')}/media/thumbnail"


async def overview(db: AsyncDatabase, user_id: str, period: str, platform: str | None) -> dict[str, Any]:
    days = PERIODS[period]
    now = _now()
    current = _match(user_id, days, platform, now=now)
    previous = _match(user_id, days, platform, offset=days, now=now)
    sums, before = await _sums(db, current), await _sums(db, previous)
    latest, latest_before = await _latest_per_target(db, current), await _latest_per_target(db, previous)
    retention, retention_before = _weighted_retention(latest), _weighted_retention(latest_before)
    engagement = sum(sums[f] for f in ("likes", "comments", "shares", "saves"))
    engagement_before = sum(before[f] for f in ("likes", "comments", "shares", "saves"))
    followers = await _new_followers(db, user_id, days, platform)
    followers_before = await _new_followers(db, user_id, days, platform, offset=days)

    series_rows = await (
        await db.metrics.aggregate(
            [
                {"$match": current},
                {
                    "$group": {
                        "_id": "$day",
                        "views": {"$sum": "$views_delta"},
                        "likes": {"$sum": "$likes_delta"},
                    }
                },
                {"$sort": {"_id": 1}},
            ]
        )
    ).to_list()
    by_day = {r["_id"]: r for r in series_rows}
    series = []
    for i in range(days - 1, -1, -1):
        d = _day(now - timedelta(days=i))
        series.append(
            {"day": d, "views": by_day.get(d, {}).get("views", 0), "likes": by_day.get(d, {}).get("likes", 0)}
        )

    platform_rows = await (
        await db.metrics.aggregate(
            [{"$match": current}, {"$group": {"_id": "$platform", "views": {"$sum": "$views_delta"}}}]
        )
    ).to_list()
    total_views = sum(r["views"] for r in platform_rows) or 0
    platforms = sorted(
        (
            {
                "platform": r["_id"],
                "views": r["views"],
                "pct": round(r["views"] / total_views * 100, 1) if total_views else 0,
            }
            for r in platform_rows
        ),
        key=lambda r: -r["views"],
    )

    top = await top_publications(db, user_id, current, latest)
    return {
        "period": period,
        "platform": platform,
        "simulated": any(r.get("simulated") for r in latest),
        "has_data": bool(latest),
        "kpis": {
            "views": {"value": sums["views"], "delta_pct": _delta_pct(sums["views"], before["views"])},
            "retention": {
                "value": retention,
                "delta_pct": round(retention - retention_before, 1)
                if retention and retention_before
                else None,
            },
            "engagement": {"value": engagement, "delta_pct": _delta_pct(engagement, engagement_before)},
            "shares": {"value": sums["shares"], "delta_pct": _delta_pct(sums["shares"], before["shares"])},
            "likes": {"value": sums["likes"], "delta_pct": _delta_pct(sums["likes"], before["likes"])},
            "followers": {"value": followers, "delta_pct": _delta_pct(followers, followers_before)},
        },
        "series": series,
        "platforms": platforms,
        "retention_curve": retention_curve(retention) if retention else None,
        "top": top,
    }


async def top_publications(
    db: AsyncDatabase, user_id: str, match: dict[str, Any], latest: list[dict[str, Any]], limit: int = 6
) -> list[dict[str, Any]]:
    gained = await (
        await db.metrics.aggregate(
            [
                {"$match": match},
                {"$group": {"_id": "$publication_id", "views": {"$sum": "$views_delta"}}},
                {"$sort": {"views": -1}},
                {"$limit": limit},
            ]
        )
    ).to_list()
    if not gained:
        return []
    per_pub: dict[str, list[dict[str, Any]]] = {}
    for row in latest:
        per_pub.setdefault(row["publication_id"], []).append(row)
    all_views = sorted(sum(r.get("views", 0) for r in rows) for rows in per_pub.values())
    out = []
    for g in gained:
        rows = per_pub.get(g["_id"]) or []
        if not rows:
            continue
        views = sum(r.get("views", 0) for r in rows)
        rank = sum(1 for v in all_views if v <= views) / len(all_views)
        out.append(
            {
                "publication_id": g["_id"],
                "title": rows[0]["title"],
                "thumbnail_url": thumb_url(rows[0]["source"]),
                "platforms": sorted({r["platform"] for r in rows}),
                "views": views,
                "views_in_period": g["views"],
                "likes": sum(r.get("likes", 0) for r in rows),
                "shares": sum(r.get("shares", 0) for r in rows),
                "comments": sum(r.get("comments", 0) for r in rows),
                "retention_pct": _weighted_retention(rows),
                # Desempenho relativo aos outros vídeos do workspace (0 a 100).
                "score": round(40 + rank * 60),
                "published_at": rows[0]["published_at"].isoformat() if rows[0].get("published_at") else None,
                "simulated": any(r.get("simulated") for r in rows),
            }
        )
    return out


async def top_titles(db: AsyncDatabase, user_id: str, limit: int) -> list[str]:
    latest = await _latest_per_target(db, {"user_id": user_id})
    views: dict[str, tuple[str, int]] = {}
    for r in latest:
        title, n = views.get(r["publication_id"], (r["title"], 0))
        views[r["publication_id"]] = (title, n + r.get("views", 0))
    ranked = sorted(views.values(), key=lambda x: -x[1])[:limit]
    return [f"{title} — {n} visualizações" for title, n in ranked]


async def followers_by_platform(db: AsyncDatabase, user_id: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    week_ago = _day(_now() - timedelta(days=7))
    for net in await db.follower_snapshots.distinct("platform", {"user_id": user_id}):
        q = {"user_id": user_id, "platform": net}
        last = await db.follower_snapshots.find_one(q, sort=[("day", -1)])
        before = await db.follower_snapshots.find_one(q | {"day": {"$lte": week_ago}}, sort=[("day", -1)])
        out[net] = {
            "followers": last["followers"],
            "delta_7d": last["followers"] - before["followers"] if before else None,
            "simulated": last.get("simulated", False),
        }
    return out


# ---------------------------------------------------------------- radar e B-roll


def _norm(text: str) -> str:
    return unicodedata.normalize("NFKD", text.lower()).encode("ascii", "ignore").decode()


async def radar(db: AsyncDatabase, user_id: str) -> dict[str, Any]:
    """Hashtags dos vídeos publicados que mais cresceram em views (14 dias contra os 14 anteriores)."""
    now = _now()
    tags_of: dict[str, set[str]] = {}
    async for pub in db.publications.find(
        {"user_id": user_id, "status": {"$in": ["published", "partial"]}}, projection={"targets": 1}
    ):
        tags = set()
        for t in pub["targets"]:
            tags.update(x.lstrip("#").lower() for x in t.get("tags") or [] if x)
            tags.update(m.lower() for m in re.findall(r"#(\w+)", t.get("description") or ""))
        tags_of[pub["_id"]] = tags
    if not tags_of:
        return {"items": [], "simulated": False}

    async def by_pub(offset: int) -> dict[str, int]:
        rows = await (
            await db.metrics.aggregate(
                [
                    {"$match": _match(user_id, 14, None, offset=offset, now=now)},
                    {"$group": {"_id": "$publication_id", "v": {"$sum": "$views_delta"}}},
                ]
            )
        ).to_list()
        return {r["_id"]: r["v"] for r in rows}

    recent, older = await by_pub(0), await by_pub(14)
    per_tag: dict[str, list[int]] = {}
    for pub_id, tags in tags_of.items():
        for tag in tags:
            acc = per_tag.setdefault(tag, [0, 0])
            acc[0] += recent.get(pub_id, 0)
            acc[1] += older.get(pub_id, 0)
    items = []
    for tag, (now_v, before_v) in per_tag.items():
        if now_v < 100:
            continue
        growth = _delta_pct(now_v, before_v)
        items.append({"keyword": f"#{tag}", "views": now_v, "growth_pct": growth})
    items.sort(key=lambda x: (x["growth_pct"] is None, -(x["growth_pct"] or 0), -x["views"]))
    simulated = await db.metrics.count_documents({"user_id": user_id, "simulated": True}, limit=1) > 0
    return {"items": items[:6], "simulated": simulated}


async def match_assets(db: AsyncDatabase, user_id: str, visuals: list[str]) -> list[dict[str, Any]]:
    """Ativos da biblioteca cujas tags ou nome aparecem na descrição visual de cada bloco."""
    assets = await db.assets.find(
        {"user_id": user_id, "deleted_at": None, "status": "ready"},
        projection={"name": 1, "type": 1, "tags": 1, "thumb_key": 1},
    ).to_list()
    out = []
    for i, text in enumerate(visuals):
        words = set(re.findall(r"[a-z0-9]{4,}", _norm(text)))
        hits = []
        for a in assets:
            keys = {_norm(t) for t in a.get("tags", [])} | set(re.findall(r"[a-z0-9]{4,}", _norm(a["name"])))
            score = len(words & keys)
            if score:
                hits.append((score, a))
        hits.sort(key=lambda x: -x[0])
        if hits:
            out.append(
                {
                    "block_index": i,
                    "assets": [
                        {
                            "id": a["_id"],
                            "name": a["name"],
                            "type": a["type"],
                            "thumb_url": f"/api/v1/assets/{a['_id']}/media/thumb"
                            if a.get("thumb_key")
                            else None,
                        }
                        for _, a in hits[:3]
                    ],
                }
            )
    return out

"""API v1 de resultados (métricas), do resumo da tela inicial e dos dados de demonstração."""

import random
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Response, status

from clipo_api.core.config import get_settings
from clipo_api.core.errors import ApiError
from clipo_api.core.workspace import WsOwner, WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import record
from clipo_api.services import analytics, connections, connectors, quota, reports
from clipo_api.services import publications as pubs
from clipo_api.services.ai import credits

router = APIRouter(prefix="/api/v1", tags=["resultados"])

Period = Literal["7d", "30d", "90d", "year"]
Net = Literal["tiktok", "instagram", "youtube"]


def _now() -> datetime:
    return datetime.now(UTC)


@router.get("/analytics/overview")
async def analytics_overview(
    user: WsUser, db: MongoDb, period: Period = "30d", platform: Net | None = None
) -> dict[str, Any]:
    return await analytics.overview(db, user.id, period, platform)


EXPORT_TYPES = {
    "pdf": ("application/pdf", reports.to_pdf),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", reports.to_xlsx),
    "csv": ("text/csv; charset=utf-8", reports.to_csv),
}


@router.get("/analytics/export")
async def analytics_export(
    user: WsUser,
    db: MongoDb,
    format: Literal["pdf", "xlsx", "csv"] = "pdf",
    period: Period = "30d",
    platform: Net | None = None,
) -> Response:
    """Relatório para baixar com os mesmos números da tela de resultados."""
    data = await analytics.overview(db, user.id, period, platform)
    owner = await db.users.find_one({"_id": user.id}, projection={"name": 1})
    workspace = f"Workspace de {owner['name']}" if owner else "Workspace"
    media_type, render = EXPORT_TYPES[format]
    body = render(data, workspace)
    await record(
        "analytics", "report.exported", f"Relatório exportado em {format.upper()}", details={"period": period}
    )
    return Response(
        body,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{reports.filename(data, format)}"'},
    )


@router.get("/dashboard")
async def dashboard(user: WsUser, db: MongoDb) -> dict[str, Any]:
    """Tudo o que a tela inicial mostra, numa chamada só."""
    now = _now()
    base = {"user_id": user.id, "deleted_at": None}
    upcoming = (
        await db.publications.find({"user_id": user.id, "status": "scheduled", "scheduled_at": {"$gte": now}})
        .sort("scheduled_at", 1)
        .limit(6)
        .to_list()
    )
    recent = await db.videos.find(base).sort("created_at", -1).limit(4).to_list()
    conns = {d["platform"]: d async for d in db.connections.find({"user_id": user.id})}
    followers = await analytics.followers_by_platform(db, user.id)
    week = await analytics.overview(db, user.id, "7d", None)
    channels = []
    for platform in connectors.CONNECTORS:
        info = connections.public_connection(platform, conns.get(platform))
        channels.append({**info, **followers.get(platform, {"followers": None, "delta_7d": None})})
    platform_series = await _platform_series(db, user.id, now)
    return {
        "platform_series": platform_series,
        "stats": {
            "videos": await db.videos.count_documents(base),
            "clips": await db.clips.count_documents(base),
            "scheduled": await db.publications.count_documents({"user_id": user.id, "status": "scheduled"}),
            "published_30d": await db.publications.count_documents(
                {
                    "user_id": user.id,
                    "status": {"$in": ["published", "partial"]},
                    "published_at": {"$gte": now - timedelta(days=30)},
                }
            ),
            "views_7d": week["kpis"]["views"],
            "followers_7d": week["kpis"]["followers"],
        },
        "views_daily": week["series"],
        "simulated": week["simulated"],
        "upcoming": [
            {**pubs.public_publication(p), "thumbnail_url": analytics.thumb_url(p["source"])}
            for p in upcoming
        ],
        "channels": channels,
        "recent_videos": [
            {
                "id": v["_id"],
                "title": v["title"],
                "status": v["status"],
                "duration_s": v.get("duration_s"),
                "thumbnail_url": f"/api/v1/videos/{v['_id']}/media/thumbnail" if v.get("thumb_key") else None,
                "created_at": v["created_at"].isoformat(),
            }
            for v in recent
        ],
        "usage": (await quota.usage(db, user.id)).as_dict(),
        "ai_credits": await credits.usage(db, user.id),
    }


async def _platform_series(db: MongoDb, user_id: str, now: datetime) -> dict[str, Any]:
    """Visualizações por dia e por rede nos últimos 30 dias, com o total contra os 30 anteriores."""
    days = [(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(29, -1, -1)]
    since = (now - timedelta(days=60)).strftime("%Y-%m-%d")
    rows = await (
        await db.metrics.aggregate(
            [
                {"$match": {"user_id": user_id, "day": {"$gt": since}}},
                {"$group": {"_id": {"d": "$day", "p": "$platform"}, "v": {"$sum": "$views_delta"}}},
            ]
        )
    ).to_list()
    by: dict[str, dict[str, int]] = {}
    for r in rows:
        by.setdefault(r["_id"]["p"], {})[r["_id"]["d"]] = r["v"]
    series, totals = {}, {}
    for platform, values in by.items():
        series[platform] = [values.get(d, 0) for d in days]
        current = sum(series[platform])
        before = sum(v for d, v in values.items() if d < days[0])
        totals[platform] = {
            "views": current,
            "delta_pct": round((current - before) / before * 100, 1) if before else None,
        }
    return {"days": days, "series": series, "totals": totals}


# ---------------------------------------------------------------- dados de demonstração

DEMO_TITLES = [
    ("3 automações de IA que cortam horas de edição", ["ia", "edicaodevideo", "produtividade"]),
    ("Minha rotina de foco profundo em blocos de 90 minutos", ["produtividade", "foco", "rotina"]),
    ("Como iluminar o setup com uma luz só", ["setup", "iluminacao", "criadordeconteudo"]),
    ("O gancho dos 3 primeiros segundos, quadro a quadro", ["retencao", "ganchos", "edicaodevideo"]),
    ("Por que o vertical domina a retenção", ["retencao", "reels", "shorts"]),
    ("Do bruto ao agendado: meu fluxo de conteúdo", ["workflow", "produtividade", "clipo"]),
    ("Microfone caro x celular: o teste cego", ["audio", "setup", "review"]),
    ("Interface escura com brilho: por que prende", ["design", "uiux", "retencao"]),
    ("Legenda animada sem plugin pago", ["legendas", "edicaodevideo", "ia"]),
    ("Gravei 30 vídeos em 2 horas: o método", ["produtividade", "lote", "criadordeconteudo"]),
]


def _dev_only() -> None:
    if get_settings().is_production:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Rota não encontrada.")


@router.post("/dev/demo-data", status_code=status.HTTP_201_CREATED)
async def create_demo_data(user: WsOwner, db: MongoDb) -> dict[str, Any]:
    """Só fora de produção: publicações já publicadas com métricas simuladas, para ver as telas cheias."""
    _dev_only()
    await delete_demo_data(user, db)
    rng = random.Random(user.id)  # noqa: S311 — dados de demonstração, não segurança
    now = _now()
    sources = (
        await db.clips.find({"user_id": user.id, "deleted_at": None, "status": "ready"}).limit(10).to_list()
    )
    kind = "clip"
    if not sources:
        sources = await db.videos.find({"user_id": user.id, "deleted_at": None}).limit(10).to_list()
        kind = "video"
    created = 0
    for i, (title, tags) in enumerate(DEMO_TITLES):
        src = sources[i % len(sources)] if sources else None
        published_at = now - timedelta(days=rng.randint(1, 45), hours=rng.randint(0, 20))
        nets = rng.sample(["tiktok", "instagram", "youtube"], rng.randint(1, 3))
        targets = []
        for net in nets:
            t = pubs.new_target(net, title, f"{title} " + " ".join(f"#{x}" for x in tags), tags, None)
            t.update(status="published", remote_id=f"demo-{uuid4().hex[:10]}", published_at=published_at)
            targets.append(t)
        pub = {
            "_id": uuid4().hex,
            "user_id": user.id,
            "source": {"kind": kind, "id": src["_id"]} if src else {"kind": "video", "id": "demo"},
            "title": title,
            "status": "published",
            "timezone": "America/Sao_Paulo",
            "scheduled_at": published_at,
            "targets": targets,
            "job_id": None,
            "attempts": 1,
            "duration_s": (src or {}).get("duration_s") or rng.randint(25, 70),
            "demo": True,
            "metrics_next_at": now + analytics.COLLECT_EVERY,
            "created_at": published_at,
            "updated_at": published_at,
            "published_at": published_at,
        }
        await db.publications.insert_one(pub)
        day = published_at
        while day <= now:
            for t in targets:
                snap = analytics.simulate(pub["_id"], t["platform"], published_at, day, pub["duration_s"])
                await analytics.store(db, pub, t["platform"], snap, day, simulated=True, demo=True)
            day += timedelta(days=1)
        for t in targets:
            snap = analytics.simulate(pub["_id"], t["platform"], published_at, now, pub["duration_s"])
            await analytics.store(db, pub, t["platform"], snap, now, simulated=True, demo=True)
        created += 1
    for net in ("tiktok", "instagram", "youtube"):
        for back in range(120, -1, -1):
            at = now - timedelta(days=back)
            count = analytics.simulate_followers(user.id, net, at)
            await analytics.save_followers(db, user.id, net, count, at, simulated=True, demo=True)
    await record("analytics", "demo.created", f"Dados de demonstração criados ({created} publicações)")
    return {"publications": created}


@router.delete("/dev/demo-data")
async def delete_demo_data(user: WsOwner, db: MongoDb) -> dict[str, Any]:
    _dev_only()
    ids = [
        p["_id"]
        async for p in db.publications.find({"user_id": user.id, "demo": True}, projection={"_id": 1})
    ]
    await db.publications.delete_many({"_id": {"$in": ids}})
    await db.metrics.delete_many({"user_id": user.id, "demo": True})
    await db.follower_snapshots.delete_many({"user_id": user.id, "demo": True})
    return {"removed": len(ids)}

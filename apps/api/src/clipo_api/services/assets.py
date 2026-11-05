"""Biblioteca de ativos: B-roll, trilhas, efeitos sonoros, overlays e presets do workspace.

O arquivo sobe direto para o S3 (um PUT só, ativos são pequenos); o worker confere com o ffprobe,
grava duração/resolução e gera a miniatura dos visuais.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from clipo_api.observability.logs import record
from clipo_api.services import media, storage

TYPES = ("video", "audio", "sfx", "overlay", "preset")
TYPE_LABEL = {
    "video": "B-roll",
    "audio": "Trilha sonora",
    "sfx": "Efeito sonoro",
    "overlay": "Overlay",
    "preset": "Preset",
}
DEFAULT_CATEGORY = {
    "video": "B-Roll",
    "audio": "Trilha Sonora",
    "sfx": "Efeitos",
    "overlay": "Overlays",
    "preset": "Presets",
}
CONTENT_TYPES: dict[str, frozenset[str]] = {
    "video": frozenset({"video/mp4", "video/quicktime", "video/webm"}),
    "overlay": frozenset(
        {"video/mp4", "video/quicktime", "video/webm", "image/png", "image/webp", "image/gif"}
    ),
    "audio": frozenset(
        {"audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac", "audio/mp4", "audio/ogg", "audio/flac"}
    ),
    "sfx": frozenset(
        {"audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac", "audio/mp4", "audio/ogg", "audio/flac"}
    ),
    "preset": frozenset({"application/json", "text/plain", "application/octet-stream"}),
}
MAX_BYTES = 500 * 1024**2
TRENDING_WINDOW = timedelta(days=7)
TRENDING_MIN_USES = 3


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def recent_uses(doc: dict[str, Any], now: datetime | None = None) -> int:
    since = (now or datetime.now(UTC)) - TRENDING_WINDOW
    return sum(1 for at in doc.get("recent_uses", []) if at.replace(tzinfo=UTC) >= since)


def public_asset(doc: dict[str, Any]) -> dict[str, Any]:
    base = f"/api/v1/assets/{doc['_id']}/media"
    return {
        "id": doc["_id"],
        "name": doc["name"],
        "type": doc["type"],
        "type_label": TYPE_LABEL[doc["type"]],
        "category": doc.get("category") or DEFAULT_CATEGORY[doc["type"]],
        "tags": doc.get("tags", []),
        "status": doc["status"],
        "error": doc.get("error"),
        "content_type": doc["content_type"],
        "size_bytes": doc.get("size_bytes"),
        "duration_s": doc.get("duration_s"),
        "width": doc.get("width"),
        "height": doc.get("height"),
        "fps": doc.get("fps"),
        "bpm": doc.get("bpm"),
        "usage_count": doc.get("usage_count", 0),
        "trending": recent_uses(doc) >= TRENDING_MIN_USES,
        "file_url": f"{base}/file" if doc["status"] == "ready" else None,
        "thumb_url": f"{base}/thumb" if doc.get("thumb_key") else None,
        "created_at": _iso(doc["created_at"]),
        "updated_at": _iso(doc.get("updated_at")),
    }


async def process(ctx: Any) -> dict[str, Any]:
    """Job `asset.process`: confere o arquivo e gera a miniatura."""
    db = ctx.db
    asset = await db.assets.find_one({"_id": ctx.job["payload"]["asset_id"], "user_id": ctx.user_id})
    if asset is None or asset.get("deleted_at"):
        return {"skipped": "ativo removido"}
    await ctx.progress(10, "Baixando o arquivo")
    src = ctx.scratch / "asset"
    if not src.exists():
        await storage.download(asset["key"], src)

    if asset["type"] == "preset":
        await db.assets.update_one(
            {"_id": asset["_id"]}, {"$set": {"status": "ready", "updated_at": datetime.now(UTC)}}
        )
        return {"asset_id": asset["_id"]}

    await ctx.progress(40, "Conferindo o arquivo")
    try:
        info = await media.probe_any(src)
    except media.MediaError as exc:
        await db.assets.update_one({"_id": asset["_id"]}, {"$set": {"status": "failed", "error": str(exc)}})
        await record(
            "content", "asset.rejected", str(exc), level="warning", outcome="failure", user_id=ctx.user_id
        )
        from clipo_api.services.processing import PermanentError

        raise PermanentError(str(exc)) from exc
    values: dict[str, Any] = {k: info[k] for k in ("duration_s", "width", "height", "fps")}

    if info["has_video"] and not asset.get("thumb_key"):
        await ctx.progress(70, "Gerando a miniatura")
        thumb = ctx.scratch / "thumb.jpg"
        at = min(1.0, (info["duration_s"] or 0) / 2)
        if await media.thumbnail(src, thumb, at):
            key = f"{storage.user_prefix(ctx.user_id)}assets/{asset['_id']}/thumb.jpg"
            await storage.upload(thumb, key, "image/jpeg")
            values.update(thumb_key=key, thumb_size=thumb.stat().st_size)

    await db.assets.update_one(
        {"_id": asset["_id"]},
        {"$set": values | {"status": "ready", "error": None, "updated_at": datetime.now(UTC)}},
    )
    await record(
        "content", "asset.ready", f"Ativo pronto: {asset['name']}", outcome="success", user_id=ctx.user_id
    )
    return {"asset_id": asset["_id"]}

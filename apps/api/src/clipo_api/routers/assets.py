"""API v1 da biblioteca de ativos do workspace."""

import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator

from clipo_api.core.errors import ApiError
from clipo_api.core.workspace import WsEditor, WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import record
from clipo_api.services import assets, jobs, quota, storage

router = APIRouter(prefix="/api/v1", tags=["biblioteca"])

AssetType = Literal["video", "audio", "sfx", "overlay", "preset"]


def _now() -> datetime:
    return datetime.now(UTC)


def _not_found() -> ApiError:
    return ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Ativo não encontrado.")


async def _owned(db: MongoDb, asset_id: str, user_id: str) -> dict[str, Any]:
    doc = await db.assets.find_one({"_id": asset_id, "user_id": user_id, "deleted_at": None})
    if doc is None:
        raise _not_found()
    return doc


def _clean_tags(value: list[str] | None) -> list[str] | None:
    if value is None:
        return None
    tags = []
    for tag in value:
        t = re.sub(r"\s+", "-", tag.strip().lower().lstrip("#"))[:30]
        if t and t not in tags:
            tags.append(t)
    return tags[:20]


@router.get("/assets")
async def list_assets(
    user: WsUser,
    db: MongoDb,
    type: AssetType | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    category: Annotated[str | None, Query(max_length=60)] = None,
    sort: Literal["recent", "popular"] = "recent",
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> dict[str, Any]:
    query: dict[str, Any] = {"user_id": user.id, "deleted_at": None}
    if type:
        query["type"] = type
    if category:
        query["category"] = category
    if q and q.strip():
        pattern = re.escape(q.strip())
        query["$or"] = [
            {"name": {"$regex": pattern, "$options": "i"}},
            {"category": {"$regex": pattern, "$options": "i"}},
            {"tags": {"$regex": pattern, "$options": "i"}},
        ]
    order = [("usage_count", -1), ("created_at", -1)] if sort == "popular" else [("created_at", -1)]
    docs = await db.assets.find(query).sort(order).limit(limit).to_list()
    counts: dict[str, int] = dict.fromkeys(assets.TYPES, 0)
    async for row in await db.assets.aggregate(
        [{"$match": {"user_id": user.id, "deleted_at": None}}, {"$group": {"_id": "$type", "n": {"$sum": 1}}}]
    ):
        counts[row["_id"]] = row["n"]
    categories = sorted(await db.assets.distinct("category", {"user_id": user.id, "deleted_at": None}))
    return {
        "items": [assets.public_asset(d) for d in docs],
        "counts": {"all": sum(counts.values()), **counts},
        "categories": categories,
    }


class AssetUploadIn(BaseModel):
    filename: Annotated[str, Field(min_length=1, max_length=200)]
    size_bytes: Annotated[int, Field(gt=0)]
    content_type: Annotated[str, Field(max_length=100)]
    type: AssetType
    name: Annotated[str | None, Field(max_length=120)] = None
    category: Annotated[str | None, Field(max_length=60)] = None
    tags: list[str] | None = None


@router.post("/assets/uploads", status_code=status.HTTP_201_CREATED)
async def start_asset_upload(body: AssetUploadIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    content_type = body.content_type.split(";")[0].strip().lower()
    if content_type not in assets.CONTENT_TYPES[body.type]:
        raise ApiError(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "unsupported_type",
            f"Esse formato não serve para {assets.TYPE_LABEL[body.type].lower()}.",
        )
    if body.size_bytes > assets.MAX_BYTES:
        raise ApiError(
            status.HTTP_413_CONTENT_TOO_LARGE, "file_too_large", "Ativos da biblioteca podem ter até 500 MB."
        )
    await quota.check_new_render(db, user.id, body.size_bytes)
    asset_id = uuid4().hex
    key = storage.new_object_key(user.id, f"assets/{asset_id}", body.filename)
    now = _now()
    name = (body.name or body.filename.rsplit(".", 1)[0]).strip()[:120] or "Sem nome"
    doc = {
        "_id": asset_id,
        "user_id": user.id,
        "created_by": user.actor_id,
        "type": body.type,
        "name": name,
        "category": (body.category or assets.DEFAULT_CATEGORY[body.type]).strip()[:60],
        "tags": _clean_tags(body.tags) or [],
        "status": "uploading",
        "key": key,
        "content_type": content_type,
        "size_bytes": body.size_bytes,
        "usage_count": 0,
        "recent_uses": [],
        "deleted_at": None,
        "created_at": now,
        "updated_at": now,
    }
    await db.assets.insert_one(doc)
    return {"asset": assets.public_asset(doc), "upload_url": storage.presign_upload(key, content_type)}


@router.post("/assets/{asset_id}/complete", status_code=status.HTTP_202_ACCEPTED)
async def complete_asset_upload(asset_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    doc = await _owned(db, asset_id, user.id)
    if doc["status"] != "uploading":
        return {"asset": assets.public_asset(doc), "job": None}
    size = await storage.object_size(doc["key"])
    if size is None:
        raise ApiError(
            status.HTTP_409_CONFLICT, "upload_incomplete", "O arquivo ainda não chegou. Envie de novo."
        )
    if size > assets.MAX_BYTES:
        await storage.delete_object(doc["key"])
        await db.assets.delete_one({"_id": asset_id})
        raise ApiError(
            status.HTTP_413_CONTENT_TOO_LARGE, "file_too_large", "Ativos da biblioteca podem ter até 500 MB."
        )
    job = await jobs.enqueue(db, "asset.process", user.id, {"asset_id": asset_id}, job_id=f"asset-{asset_id}")
    doc = await db.assets.find_one_and_update(
        {"_id": asset_id},
        {"$set": {"status": "processing", "size_bytes": size, "job_id": job["_id"], "updated_at": _now()}},
        return_document=True,
    )
    await record("content", "asset.uploaded", f"Ativo enviado: {doc['name']}", outcome="success")
    return {"asset": assets.public_asset(doc), "job": jobs.public_job(job)}


@router.get("/assets/{asset_id}")
async def get_asset(asset_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    return {"asset": assets.public_asset(await _owned(db, asset_id, user.id))}


class AssetEditIn(BaseModel):
    name: Annotated[str | None, Field(min_length=1, max_length=120)] = None
    category: Annotated[str | None, Field(min_length=1, max_length=60)] = None
    tags: list[str] | None = None
    bpm: Annotated[int | None, Field(ge=20, le=300)] = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str] | None) -> list[str] | None:
        return _clean_tags(value)


@router.patch("/assets/{asset_id}")
async def edit_asset(asset_id: str, body: AssetEditIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    await _owned(db, asset_id, user.id)
    changes = {
        k: (v.strip() if isinstance(v, str) else v) for k, v in body.model_dump(exclude_unset=True).items()
    }
    doc = await db.assets.find_one_and_update(
        {"_id": asset_id}, {"$set": changes | {"updated_at": _now()}}, return_document=True
    )
    return {"asset": assets.public_asset(doc)}


@router.post("/assets/{asset_id}/use")
async def use_asset(asset_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    """Conta um uso (copiar para um projeto, baixar). Alimenta "mais usados" e "em alta"."""
    await _owned(db, asset_id, user.id)
    doc = await db.assets.find_one_and_update(
        {"_id": asset_id},
        {"$inc": {"usage_count": 1}, "$push": {"recent_uses": {"$each": [_now()], "$slice": -50}}},
        return_document=True,
    )
    return {"asset": assets.public_asset(doc)}


@router.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    doc = await _owned(db, asset_id, user.id)
    await db.assets.update_one({"_id": asset_id}, {"$set": {"deleted_at": _now()}})
    for key in (doc.get("key"), doc.get("thumb_key")):
        if key:
            try:
                await storage.delete_object(key)
            except storage.StorageNotConfigured:
                pass
    await db.assets.delete_one({"_id": asset_id})
    await record("content", "asset.deleted", f"Ativo apagado: {doc['name']}", outcome="success")
    return {"ok": True}


@router.get("/assets/{asset_id}/media/{kind}", include_in_schema=False)
async def asset_media(
    asset_id: str, kind: Literal["file", "thumb"], user: WsUser, db: MongoDb
) -> RedirectResponse:
    doc = await _owned(db, asset_id, user.id)
    key = doc.get("key") if kind == "file" else doc.get("thumb_key")
    if not key or (kind == "file" and doc["status"] != "ready"):
        raise _not_found()
    response = RedirectResponse(storage.presign_download(key), status_code=status.HTTP_302_FOUND)
    response.headers["Cache-Control"] = "private, max-age=60"
    return response

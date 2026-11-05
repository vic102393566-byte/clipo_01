"""API v1 de vídeos: envio em partes, biblioteca, cortes, lixeira, jobs e uso do plano.

Envio (o arquivo nunca passa pela API):
  1. POST /uploads            → cota conferida; o S3 abre um envio em partes
  2. POST /uploads/{id}/parts → URLs assinadas para as partes que faltam
     (o navegador manda cada parte direto ao S3; se a conexão cair, pergunta o que falta e segue)
  3. GET  /uploads/{id}       → partes que o S3 já recebeu (retomada)
  4. POST /uploads/{id}/complete → o S3 junta as partes; o vídeo entra na fila de processamento
"""

import asyncio
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Query, Request, status
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from clipo_api.core.errors import ApiError
from clipo_api.core.ratelimit import hit
from clipo_api.core.workspace import WsEditor, WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import record
from clipo_api.services import jobs, media, processing, quota, storage
from clipo_api.services import settings as settings_service

router = APIRouter(prefix="/api/v1", tags=["vídeos"])

VIDEO_TYPES = {"video/mp4", "video/quicktime", "video/webm", "video/x-matroska"}
TRASH_DAYS = 7
MAX_PART_URLS = 100
Title = Annotated[str, Field(min_length=1, max_length=200)]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _clean_title(value: str) -> str:
    value = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", " ".join(value.split()))
    return value[:200] or "Vídeo sem título"


async def _ensure_not_scheduled(db: MongoDb, user_id: str, video_id: str, clip_ids: list[str]) -> None:
    """Não deixa ir para a lixeira o que tem publicação agendada ou saindo."""
    sources = [{"source.kind": "video", "source.id": video_id}] if video_id else []
    if clip_ids:
        sources.append({"source.kind": "clip", "source.id": {"$in": clip_ids}})
    busy = await db.publications.count_documents(
        {"user_id": user_id, "status": {"$in": ["scheduled", "paused", "publishing"]}, "$or": sources}
    )
    if busy:
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "has_scheduled_publications",
            f"Há {busy} publicação(ões) agendada(s) com este conteúdo. "
            "Cancele ou desfaça o agendamento antes.",
        )


async def _trash_days(db: MongoDb, user_id: str) -> int:
    return int((await settings_service.workspace(db, user_id))["privacy"]["trash_days"] or TRASH_DAYS)


async def _night(db: MongoDb, user_id: str) -> datetime | None:
    """Fila da madrugada ligada: render pesado pedido de dia espera até 1 h."""
    if (await settings_service.workspace(db, user_id))["render"]["night_queue"]:
        return settings_service.night_run_at()
    return None


def _not_found(what: str = "Vídeo") -> ApiError:
    return ApiError(status.HTTP_404_NOT_FOUND, "not_found", f"{what} não encontrado.")


# ---------------------------------------------------------------- envio em partes


class UploadIn(BaseModel):
    filename: Annotated[str, Field(min_length=1, max_length=255)]
    content_type: Annotated[str, Field(max_length=60)]
    size_bytes: Annotated[int, Field(gt=0)]


def _upload_out(doc: dict[str, Any], uploaded: list[int] | None = None) -> dict[str, Any]:
    return {
        "id": doc["_id"],
        "status": doc["status"],
        "filename": doc["filename"],
        "size_bytes": doc["size_bytes"],
        "part_size": doc["part_size"],
        "parts_count": doc["parts_count"],
        "uploaded_parts": uploaded if uploaded is not None else [],
        "video_id": doc.get("video_id"),
        "created_at": doc["created_at"].isoformat(),
    }


async def _owned_upload(db: MongoDb, upload_id: str, user_id: str) -> dict[str, Any]:
    doc = await db.uploads.find_one({"_id": upload_id, "user_id": user_id})
    if doc is None:
        raise _not_found("Envio")
    return doc


@router.post("/uploads", status_code=status.HTTP_201_CREATED)
async def start_upload(body: UploadIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    if body.content_type not in VIDEO_TYPES:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST, "unsupported_type", "Envie um vídeo MP4, MOV, WEBM ou MKV."
        )
    await hit(db, "upload:user", user.id, limit=60, window_seconds=3600)
    await quota.check_new_upload(db, user.id, body.size_bytes)

    upload_id = uuid4().hex
    key = storage.new_object_key(user.id, f"originals/{upload_id}", body.filename)
    s3_upload_id = await storage.create_multipart(key, body.content_type)
    part_size = storage.part_size_for(body.size_bytes)
    doc = {
        "_id": upload_id,
        "user_id": user.id,
        "key": key,
        "s3_upload_id": s3_upload_id,
        "filename": body.filename[:255],
        "content_type": body.content_type,
        "size_bytes": body.size_bytes,
        "part_size": part_size,
        "parts_count": -(-body.size_bytes // part_size),
        "status": "uploading",
        "created_at": _now(),
    }
    await db.uploads.insert_one(doc)
    await record(
        "video",
        "upload.started",
        f"Envio iniciado: {body.filename}",
        details={"upload_id": upload_id, "size": body.size_bytes, "parts": doc["parts_count"]},
    )
    return {"upload": _upload_out(doc)}


class PartsIn(BaseModel):
    part_numbers: Annotated[list[Annotated[int, Field(ge=1, le=storage.MAX_PARTS)]], Field(min_length=1)]


@router.post("/uploads/{upload_id}/parts")
async def sign_parts(upload_id: str, body: PartsIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    doc = await _owned_upload(db, upload_id, user.id)
    if doc["status"] != "uploading":
        raise ApiError(status.HTTP_409_CONFLICT, "upload_closed", "Este envio já foi concluído ou cancelado.")
    numbers = sorted(set(body.part_numbers))[:MAX_PART_URLS]
    if numbers[-1] > doc["parts_count"]:
        raise ApiError(status.HTTP_400_BAD_REQUEST, "invalid_part", "Número de parte fora do arquivo.")
    return {
        "urls": [
            {"part_number": n, "url": storage.presign_part(doc["key"], doc["s3_upload_id"], n)}
            for n in numbers
        ]
    }


@router.get("/uploads/{upload_id}")
async def upload_status(upload_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    doc = await _owned_upload(db, upload_id, user.id)
    uploaded = (
        [p["PartNumber"] for p in await storage.list_parts(doc["key"], doc["s3_upload_id"])]
        if doc["status"] == "uploading"
        else []
    )
    return {"upload": _upload_out(doc, uploaded)}


class CompleteIn(BaseModel):
    title: Annotated[str, Field(max_length=200)] = ""


@router.post("/uploads/{upload_id}/complete")
async def complete_upload(upload_id: str, body: CompleteIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    doc = await _owned_upload(db, upload_id, user.id)
    if doc["status"] == "completed":
        video = await db.videos.find_one({"_id": doc["video_id"]})
        return {"video": _video_out(video)}
    if doc["status"] != "uploading":
        raise ApiError(status.HTTP_409_CONFLICT, "upload_closed", "Este envio foi cancelado.")

    # O servidor confere com o S3 o que chegou: não confia na lista que o navegador mandaria.
    parts = await storage.list_parts(doc["key"], doc["s3_upload_id"])
    received = {p["PartNumber"] for p in parts}
    missing = [n for n in range(1, doc["parts_count"] + 1) if n not in received]
    if missing:
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "upload_incomplete",
            f"Faltam {len(missing)} parte(s) do arquivo. Continue o envio.",
        )
    if sum(p["Size"] for p in parts) != doc["size_bytes"]:
        raise ApiError(
            status.HTTP_409_CONFLICT, "upload_size_mismatch", "O arquivo enviado não tem o tamanho informado."
        )
    await storage.complete_multipart(
        doc["key"], doc["s3_upload_id"], sorted(parts, key=lambda p: p["PartNumber"])
    )

    now = _now()
    video = {
        "_id": uuid4().hex,
        "user_id": user.id,
        "upload_id": upload_id,
        "title": _clean_title(body.title or doc["filename"]),
        "description": "",
        "tags": [],
        "status": "processing",
        "source_key": doc["key"],
        "source_size": doc["size_bytes"],
        "content_type": doc["content_type"],
        "filename": doc["filename"],
        "duration_s": None,
        "created_at": now,
        "updated_at": now,
        "schema_version": 2,
    }
    await db.videos.insert_one(video)
    job = await jobs.enqueue(db, "video.ingest", user.id, {"video_id": video["_id"]})
    await db.videos.update_one({"_id": video["_id"]}, {"$set": {"job_id": job["_id"]}})
    await db.uploads.update_one(
        {"_id": upload_id}, {"$set": {"status": "completed", "video_id": video["_id"]}}
    )
    video["job_id"] = job["_id"]
    await record(
        "video",
        "upload.completed",
        f"Envio concluído: {video['title']}",
        outcome="success",
        details={"video_id": video["_id"], "size": doc["size_bytes"], "parts": doc["parts_count"]},
    )
    return {"video": _video_out(video), "job": jobs.public_job(job)}


@router.delete("/uploads/{upload_id}")
async def cancel_upload(upload_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    doc = await _owned_upload(db, upload_id, user.id)
    if doc["status"] == "uploading":
        await storage.abort_multipart(doc["key"], doc["s3_upload_id"])
        await db.uploads.update_one({"_id": upload_id}, {"$set": {"status": "aborted"}})
        await record("video", "upload.aborted", f"Envio cancelado: {doc['filename']}")
    return {"message": "Envio cancelado."}


# ---------------------------------------------------------------- biblioteca


def _video_out(v: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": v["_id"],
        "title": v["title"],
        "description": v.get("description", ""),
        "tags": v.get("tags", []),
        "status": v["status"],
        "error": v.get("error"),
        "duration_s": v.get("duration_s"),
        "width": v.get("width"),
        "height": v.get("height"),
        "size_bytes": v.get("source_size", 0),
        "filename": v.get("filename"),
        "thumbnail_url": f"/api/v1/videos/{v['_id']}/media/thumbnail" if v.get("thumb_key") else None,
        "preview_url": f"/api/v1/videos/{v['_id']}/media/preview" if v.get("preview_key") else None,
        "source_url": f"/api/v1/videos/{v['_id']}/media/source" if v.get("status") == "ready" else None,
        "job_id": v.get("job_id"),
        "created_at": v["created_at"].isoformat(),
        "deleted_at": _iso(v.get("deleted_at")),
        "purge_after": _iso(v.get("purge_after")),
    }


def _clip_out(c: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": c["_id"],
        "video_id": c["video_id"],
        "title": c["title"],
        "description": c.get("description", ""),
        "tags": c.get("tags", []),
        "index": c.get("index"),
        "start_s": c["start_s"],
        "end_s": c["end_s"],
        "duration_s": c.get("duration_s") or c["end_s"] - c["start_s"],
        "status": c["status"],
        "size_bytes": c.get("size", 0),
        "media_url": f"/api/v1/clips/{c['_id']}/media/video" if c.get("key") else None,
        "thumbnail_url": f"/api/v1/clips/{c['_id']}/media/thumbnail" if c.get("thumb_key") else None,
        "subtitled_url": f"/api/v1/clips/{c['_id']}/media/subtitled" if c.get("subtitled_key") else None,
        "job_id": c.get("job_id"),
        "created_at": c["created_at"].isoformat(),
        "deleted_at": _iso(c.get("deleted_at")),
    }


def _cursor_query(cursor: str | None) -> dict[str, Any]:
    if not cursor:
        return {}
    try:
        created, item_id = json.loads(cursor)
        created_at = datetime.fromisoformat(created)
    except (ValueError, TypeError) as exc:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST, "invalid_cursor", "Cursor de paginação inválido."
        ) from exc
    return {"$or": [{"created_at": {"$lt": created_at}}, {"created_at": created_at, "_id": {"$lt": item_id}}]}


@router.get("/videos")
async def list_videos(
    user: WsUser,
    db: MongoDb,
    status_: Annotated[
        Literal["processing", "ready", "failed", "rejected"] | None, Query(alias="status")
    ] = None,
    trash: bool = False,
    publish: Literal["published", "queued", "draft"] | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 24,
) -> dict[str, Any]:
    query: dict[str, Any] = {"user_id": user.id, "deleted_at": {"$ne": None} if trash else None}
    if status_:
        query["status"] = status_
    if q:
        query["title"] = {"$regex": re.escape(q), "$options": "i"}
    states = await _publish_states(db, user.id)
    if publish == "draft":
        query["_id"] = {"$nin": list(states)}
    elif publish:
        query["_id"] = {"$in": [vid for vid, st in states.items() if st["state"] == publish]}
    query.update(_cursor_query(cursor))
    docs = await db.videos.find(query).sort([("created_at", -1), ("_id", -1)]).limit(limit + 1).to_list()
    more = len(docs) > limit
    docs = docs[:limit]
    empty = {"state": "draft", "platforms": []}
    return {
        "items": [_video_out(d) | {"publish": states.get(d["_id"], empty)} for d in docs],
        "next_cursor": json.dumps([docs[-1]["created_at"].isoformat(), docs[-1]["_id"]]) if more else None,
    }


async def _publish_states(db: MongoDb, user_id: str) -> dict[str, dict[str, Any]]:
    """Estado de publicação de cada vídeo (dele ou de qualquer corte): publicado ganha de na fila."""
    pubs = (
        await db.publications.find(
            {
                "user_id": user_id,
                "status": {"$in": ["published", "partial", "scheduled", "paused", "publishing"]},
            },
            projection={"source": 1, "status": 1, "targets.platform": 1, "targets.status": 1},
        )
        .limit(3000)
        .to_list()
    )
    clip_ids = [p["source"]["id"] for p in pubs if p["source"]["kind"] == "clip"]
    parent = {
        c["_id"]: c["video_id"]
        async for c in db.clips.find({"_id": {"$in": clip_ids}}, projection={"video_id": 1})
    }
    out: dict[str, dict[str, Any]] = {}
    for p in pubs:
        vid = p["source"]["id"] if p["source"]["kind"] == "video" else parent.get(p["source"]["id"])
        if not vid:
            continue
        cur = out.setdefault(vid, {"state": "queued", "platforms": set()})
        if p["status"] in ("published", "partial"):
            cur["state"] = "published"
            cur["platforms"].update(t["platform"] for t in p["targets"] if t.get("status") == "published")
        elif cur["state"] != "published":
            cur["platforms"].update(t["platform"] for t in p["targets"])
    return {vid: {"state": st["state"], "platforms": sorted(st["platforms"])} for vid, st in out.items()}


async def _owned_video(
    db: MongoDb, video_id: str, user_id: str, *, allow_trash: bool = False
) -> dict[str, Any]:
    doc = await db.videos.find_one({"_id": video_id, "user_id": user_id})
    if doc is None or (doc.get("deleted_at") and not allow_trash):
        raise _not_found()
    return doc


@router.get("/videos/{video_id}/waveform")
async def video_waveform(video_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    """Forma de onda do áudio, calculada na primeira vez e guardada no vídeo."""
    video = await _owned_video(db, video_id, user.id)
    if video.get("waveform") is not None:
        return {"peaks": video["waveform"]}
    key = video.get("preview_key") or video.get("source_key")
    if video["status"] != "ready" or not key or not video.get("has_audio", True):
        return {"peaks": []}
    try:
        peaks = await media.waveform(storage.internal_url(key), float(video.get("duration_s") or 0))
    except media.MediaError:
        return {"peaks": []}
    await db.videos.update_one({"_id": video_id}, {"$set": {"waveform": peaks}})
    return {"peaks": peaks}


@router.get("/videos/{video_id}")
async def get_video(video_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    video = await _owned_video(db, video_id, user.id, allow_trash=True)
    clips = (
        await db.clips.find({"video_id": video_id, "user_id": user.id, "deleted_at": None})
        .sort([("job_id", 1), ("index", 1), ("created_at", 1)])
        .to_list()
    )
    return {"video": _video_out(video), "clips": [_clip_out(c) for c in clips]}


class EditIn(BaseModel):
    title: Title | None = None
    description: Annotated[str, Field(max_length=5000)] | None = None
    tags: Annotated[list[Annotated[str, Field(min_length=1, max_length=60)]], Field(max_length=30)] | None = (
        None
    )

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        seen: list[str] = []
        for tag in (t.strip().lstrip("#") for t in value):
            if tag and tag.lower() not in {s.lower() for s in seen}:
                seen.append(tag)
        return seen


@router.patch("/videos/{video_id}")
async def edit_video(video_id: str, body: EditIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    await _owned_video(db, video_id, user.id)
    changes = body.model_dump(exclude_none=True)
    if changes:
        await db.videos.update_one({"_id": video_id}, {"$set": {**changes, "updated_at": _now()}})
    return {"video": _video_out(await _owned_video(db, video_id, user.id))}


@router.delete("/videos/{video_id}")
async def trash_video(video_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    """Vai para a lixeira com os cortes. Some de vez no prazo do workspace (o worker apaga)."""
    await _owned_video(db, video_id, user.id)
    clip_ids = await db.clips.distinct("_id", {"video_id": video_id, "user_id": user.id, "deleted_at": None})
    await _ensure_not_scheduled(db, user.id, video_id, clip_ids)
    now = _now()
    days = await _trash_days(db, user.id)
    fields = {"deleted_at": now, "purge_after": now + timedelta(days=days)}
    await db.videos.update_one({"_id": video_id}, {"$set": fields})
    await db.clips.update_many(
        {"video_id": video_id, "user_id": user.id, "deleted_at": None}, {"$set": fields}
    )
    await record("video", "trashed", "Vídeo enviado para a lixeira", details={"video_id": video_id})
    return {"message": f"Vídeo na lixeira. Ele some de vez em {days} dias."}


@router.post("/videos/{video_id}/restore")
async def restore_video(video_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    video = await _owned_video(db, video_id, user.id, allow_trash=True)
    if not video.get("deleted_at"):
        return {"video": _video_out(video)}
    await db.videos.update_one({"_id": video_id}, {"$set": {"deleted_at": None, "purge_after": None}})
    await db.clips.update_many(
        {"video_id": video_id, "user_id": user.id, "deleted_at": video["deleted_at"]},
        {"$set": {"deleted_at": None, "purge_after": None}},
    )
    await record("video", "restored", "Vídeo restaurado da lixeira", details={"video_id": video_id})
    return {"video": _video_out(await _owned_video(db, video_id, user.id))}


_VIDEO_MEDIA = {"source": "source_key", "preview": "preview_key", "thumbnail": "thumb_key"}
_CLIP_MEDIA = {"video": "key", "thumbnail": "thumb_key", "subtitled": "subtitled_key"}


@router.get("/videos/{video_id}/media/{kind}", include_in_schema=False)
async def video_media(video_id: str, kind: str, user: WsUser, db: MongoDb) -> RedirectResponse:
    video = await _owned_video(db, video_id, user.id, allow_trash=True)
    key = video.get(_VIDEO_MEDIA.get(kind, ""))
    if not key:
        raise _not_found("Arquivo")
    return RedirectResponse(storage.presign_download(key), status_code=status.HTTP_302_FOUND)


# ---------------------------------------------------------------- cortes


class SplitIn(BaseModel):
    segment_seconds: Annotated[int, Field(ge=5, le=3 * 3600)]


@router.post("/videos/{video_id}/split", status_code=status.HTTP_202_ACCEPTED)
async def split_video(video_id: str, body: SplitIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    video = await _owned_video(db, video_id, user.id)
    if video["status"] != "ready":
        raise ApiError(status.HTTP_409_CONFLICT, "not_ready", "O vídeo ainda está sendo processado.")
    parts = -(-int(video["duration_s"]) // body.segment_seconds)
    if parts > 200:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST, "too_many_parts", f"Isso geraria {parts} partes; o máximo é 200."
        )
    await hit(db, "split:user", user.id, limit=30, window_seconds=3600)
    active = await db.jobs.count_documents(
        {
            "user_id": user.id,
            "type": {"$in": ["video.split", "clip.render"]},
            "status": {"$in": ["queued", "running"]},
        }
    )
    if active >= 3:
        raise ApiError(
            status.HTTP_429_TOO_MANY_REQUESTS, "too_many_jobs", "Já há 3 cortes em andamento. Aguarde."
        )
    # Cortes reencodados ocupam mais ou menos o mesmo que o original.
    await quota.check_new_render(db, user.id, video["source_size"])
    job = await jobs.enqueue(
        db,
        "video.split",
        user.id,
        {"video_id": video_id, "segment_seconds": body.segment_seconds},
        run_at=await _night(db, user.id),
    )
    await record(
        "job",
        "split.queued",
        f"Corte em partes de {body.segment_seconds}s na fila",
        details={"job_id": job["_id"], "video_id": video_id, "parts": parts},
    )
    return {"job": jobs.public_job(job)}


class ClipIn(BaseModel):
    start_s: Annotated[float, Field(ge=0)]
    end_s: Annotated[float, Field(gt=0)]
    title: Title | None = None


@router.post("/videos/{video_id}/clips", status_code=status.HTTP_202_ACCEPTED)
async def create_clip(video_id: str, body: ClipIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    """Corte manual de um trecho (o editor da linha do tempo usa esta rota)."""
    video = await _owned_video(db, video_id, user.id)
    if video["status"] != "ready":
        raise ApiError(status.HTTP_409_CONFLICT, "not_ready", "O vídeo ainda está sendo processado.")
    clip, job = await enqueue_clip(db, user.id, video, body.start_s, body.end_s, body.title)
    return {"clip": _clip_out(clip), "job": jobs.public_job(job)}


async def enqueue_clip(
    db: MongoDb,
    user_id: str,
    video: dict[str, Any],
    start_s: float,
    end_s: float,
    title: str | None,
    **extra: Any,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Cria o corte e põe a renderização na fila (corte manual e sugestão da IA aceita)."""
    end = min(end_s, video["duration_s"])
    if end - start_s < 1:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST, "invalid_range", "O trecho precisa ter pelo menos 1 segundo."
        )
    await quota.check_new_render(
        db, user_id, int(video["source_size"] * (end - start_s) / max(video["duration_s"], 1))
    )
    clip = {
        "_id": uuid4().hex,
        "user_id": user_id,
        "video_id": video["_id"],
        "title": title or f"{video['title']} - Trecho",
        "description": "",
        "tags": [],
        "start_s": start_s,
        "end_s": end,
        "status": "queued",
        "created_at": _now(),
        "schema_version": 1,
        **extra,
    }
    job = await jobs.enqueue(
        db, "clip.render", user_id, {"clip_id": clip["_id"]}, run_at=await _night(db, user_id)
    )
    clip["job_id"] = job["_id"]
    await db.clips.insert_one(clip)
    return clip, job


async def _owned_clip(db: MongoDb, clip_id: str, user_id: str) -> dict[str, Any]:
    doc = await db.clips.find_one({"_id": clip_id, "user_id": user_id, "deleted_at": None})
    if doc is None:
        raise _not_found("Corte")
    return doc


@router.get("/clips/{clip_id}")
async def get_clip(clip_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    return {"clip": _clip_out(await _owned_clip(db, clip_id, user.id))}


@router.patch("/clips/{clip_id}")
async def edit_clip(clip_id: str, body: EditIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    await _owned_clip(db, clip_id, user.id)
    changes = body.model_dump(exclude_none=True)
    if changes:
        await db.clips.update_one({"_id": clip_id}, {"$set": {**changes, "updated_at": _now()}})
    return {"clip": _clip_out(await _owned_clip(db, clip_id, user.id))}


@router.delete("/clips/{clip_id}")
async def trash_clip(clip_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    await _owned_clip(db, clip_id, user.id)
    await _ensure_not_scheduled(db, user.id, "", [clip_id])
    now = _now()
    days = await _trash_days(db, user.id)
    await db.clips.update_one(
        {"_id": clip_id}, {"$set": {"deleted_at": now, "purge_after": now + timedelta(days=days)}}
    )
    return {"message": f"Corte na lixeira. Ele some de vez em {days} dias."}


@router.get("/clips/{clip_id}/media/{kind}", include_in_schema=False)
async def clip_media(clip_id: str, kind: str, user: WsUser, db: MongoDb) -> RedirectResponse:
    clip = await _owned_clip(db, clip_id, user.id)
    key = clip.get(_CLIP_MEDIA.get(kind, ""))
    if not key:
        raise _not_found("Arquivo")
    return RedirectResponse(storage.presign_download(key), status_code=status.HTTP_302_FOUND)


# ---------------------------------------------------------------- jobs e uso


async def _owned_job(db: MongoDb, job_id: str, user_id: str) -> dict[str, Any]:
    job = await db.jobs.find_one({"_id": job_id, "user_id": user_id})
    if job is None:
        raise _not_found("Processamento")
    return job


@router.get("/jobs")
async def list_jobs(
    user: WsUser, db: MongoDb, active: bool = True, limit: Annotated[int, Query(ge=1, le=100)] = 20
) -> dict[str, Any]:
    query: dict[str, Any] = {"user_id": user.id}
    if active:
        query["status"] = {"$in": ["queued", "running"]}
    docs = await db.jobs.find(query).sort("created_at", -1).limit(limit).to_list()
    return {"items": [jobs.public_job(j) for j in docs]}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    return {"job": jobs.public_job(await _owned_job(db, job_id, user.id))}


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    await _owned_job(db, job_id, user.id)
    job = await jobs.request_cancel(db, job_id, user.id)
    if job:
        # Cancelado na fila: devolve créditos e desfaz o que o worker desfaria.
        await processing.cancelled_in_queue(db, job)
    await record("job", "cancel.requested", "Cancelamento pedido", details={"job_id": job_id})
    return {"job": jobs.public_job(job or await _owned_job(db, job_id, user.id))}


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request, user: WsUser, db: MongoDb) -> StreamingResponse:
    """Andamento em tempo real (Server-Sent Events), a partir das mudanças do próprio MongoDB."""
    await _owned_job(db, job_id, user.id)

    def event(job: dict[str, Any]) -> str:
        return f"event: job\ndata: {json.dumps(jobs.public_job(job), ensure_ascii=False)}\n\n"

    async def stream():
        job = await db.jobs.find_one({"_id": job_id})
        yield event(job)
        if job["status"] in jobs.TERMINAL:
            return
        pipeline = [{"$match": {"documentKey._id": job_id}}]
        async with await db.jobs.watch(
            pipeline, full_document="updateLookup", max_await_time_ms=15000
        ) as changes:
            while not await request.is_disconnected():
                change = await changes.try_next()
                if change is None:
                    yield ": ainda processando\n\n"  # mantém a conexão aberta
                    continue
                current = change.get("fullDocument")
                if current is None:
                    return
                yield event(current)
                if current["status"] in jobs.TERMINAL:
                    return
                await asyncio.sleep(0)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/usage")
async def get_usage(user: WsUser, db: MongoDb) -> dict[str, Any]:
    return {"usage": (await quota.usage(db, user.id)).as_dict()}

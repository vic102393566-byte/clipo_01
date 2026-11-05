"""API v1 de publicações (agendar, calendário, reagendar, publicar agora) e dos avisos (sino)."""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, Field, field_validator, model_validator
from pymongo import ReturnDocument

from clipo_api.core.auth import AuthUser
from clipo_api.core.errors import ApiError
from clipo_api.core.workspace import WsPublisher, WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import record
from clipo_api.services import connections, connectors, jobs
from clipo_api.services import publications as pubs
from clipo_api.services.connectors.base import ConnectorError, NotSupported
from clipo_api.services.notifications import public_notification

router = APIRouter(prefix="/api/v1", tags=["publicações"])

Platform = Literal["youtube", "instagram", "tiktok"]
MAX_RANGE = timedelta(days=93)
MAX_AHEAD = timedelta(days=366)


def _now() -> datetime:
    return datetime.now(UTC)


def _error(exc: pubs.PublicationError) -> ApiError:
    return ApiError(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.code, exc.message)


def _valid_tz(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Fuso horário inválido.") from exc
    return value


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _not_found() -> ApiError:
    return ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Publicação não encontrada.")


class TargetIn(BaseModel):
    platform: Platform
    title: Annotated[str, Field(max_length=200)] | None = None
    description: Annotated[str, Field(max_length=5000)] | None = None
    tags: Annotated[list[Annotated[str, Field(max_length=40)]], Field(max_length=30)] | None = None
    privacy: Annotated[str, Field(max_length=40)] | None = None


class ScheduleFields(BaseModel):
    """Data e hora: com fuso no texto (2026-11-02T10:00:00-03:00) ou local + `timezone`."""

    scheduled_at: datetime | None = None
    timezone: Annotated[str, Field(max_length=60)] = "America/Sao_Paulo"

    @field_validator("timezone")
    @classmethod
    def _tz(cls, value: str) -> str:
        return _valid_tz(value)

    def when(self) -> datetime | None:
        if self.scheduled_at is None:
            return None
        value = self.scheduled_at
        if value.tzinfo is None:
            value = value.replace(tzinfo=ZoneInfo(self.timezone))
        return value.astimezone(UTC).replace(microsecond=0)


class PublicationIn(ScheduleFields):
    source_kind: Literal["video", "clip"]
    source_id: Annotated[str, Field(min_length=1, max_length=80)]
    title: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    description: Annotated[str, Field(max_length=5000)] = ""
    tags: Annotated[list[Annotated[str, Field(max_length=40)]], Field(max_length=30)] = []
    targets: Annotated[list[TargetIn], Field(min_length=1, max_length=3)]
    # draft: só salva; schedule: agenda para scheduled_at; now: publica já.
    action: Literal["draft", "schedule", "now"] = "schedule"

    @model_validator(mode="after")
    def _check(self) -> "PublicationIn":
        if len({t.platform for t in self.targets}) != len(self.targets):
            raise ValueError("Cada rede aparece uma vez só.")
        if self.action == "schedule" and self.scheduled_at is None:
            raise ValueError("Informe a data e a hora para agendar.")
        return self


class PublicationPatch(ScheduleFields):
    title: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    targets: Annotated[list[TargetIn], Field(min_length=1, max_length=3)] | None = None
    timezone: Annotated[str, Field(max_length=60)] | None = None  # type: ignore[assignment]

    @field_validator("timezone")
    @classmethod
    def _tz(cls, value: str | None) -> str | None:
        return None if value is None else _valid_tz(value)


class ScheduleIn(ScheduleFields):
    scheduled_at: datetime


def _check_when(when: datetime) -> None:
    if when < _now() - timedelta(seconds=30):
        raise ApiError(status.HTTP_422_UNPROCESSABLE_ENTITY, "in_the_past", "Escolha uma data no futuro.")
    if when > _now() + MAX_AHEAD:
        raise ApiError(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "too_far", "Dá para agendar até um ano à frente."
        )


async def _owned(db: MongoDb, pub_id: str, user_id: str) -> dict[str, Any]:
    pub = await db.publications.find_one({"_id": pub_id, "user_id": user_id})
    if pub is None:
        raise _not_found()
    return pub


async def _validate(
    db: MongoDb, user_id: str, source: dict[str, Any], targets: list[dict[str, Any]], *, connected: bool
) -> None:
    try:
        for t in targets:
            pubs.check_target(t["platform"], t, source["duration_s"])
            if connected:
                await pubs.check_connected(db, user_id, t["platform"])
    except pubs.PublicationError as exc:
        raise _error(exc) from exc


def _targets(body_targets: list[TargetIn], title: str, description: str, tags: list[str]) -> list[dict]:
    return [
        pubs.new_target(
            t.platform,
            (t.title if t.title is not None else title).strip(),
            t.description if t.description is not None else description,
            t.tags if t.tags is not None else tags,
            t.privacy,
        )
        for t in body_targets
    ]


@router.post("/publications", status_code=status.HTTP_201_CREATED)
async def create_publication(body: PublicationIn, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    try:
        source = await pubs.load_source(db, user.id, body.source_kind, body.source_id)
    except pubs.PublicationError as exc:
        raise _error(exc) from exc
    title = " ".join((body.title or source["title"]).split())
    targets = _targets(body.targets, title, body.description, body.tags)
    await _validate(db, user.id, source, targets, connected=body.action != "draft")
    when = body.when()
    if body.action == "schedule":
        _check_when(when)
    now = _now()
    pub = {
        "_id": f"p{now:%y%m%d}{uuid4().hex[:12]}",
        "user_id": user.id,
        "source": {"kind": body.source_kind, "id": body.source_id},
        "title": title,
        "status": "draft",
        "timezone": body.timezone,
        "scheduled_at": when if body.action != "now" else now,
        "targets": targets,
        "job_id": None,
        "attempts": 0,
        "created_at": now,
        "updated_at": now,
        "published_at": None,
    }
    if body.action == "schedule":
        pub["status"] = "scheduled"
    await db.publications.insert_one(pub)
    if body.action == "now":
        pub = await pubs.start_publishing(db, pub["_id"], from_status=("draft",), user_id=user.id)
    event, verb = {
        "draft": ("drafted", "salva como rascunho"),
        "schedule": ("scheduled", "agendada"),
        "now": ("publish_now", "enviada agora"),
    }[body.action]
    await record(
        "publication",
        f"publication.{event}",
        f"Publicação {verb} ({', '.join(t['platform'] for t in targets)})",
        outcome="success",
        details={"publication_id": pub["_id"], "scheduled_at": when.isoformat() if when else None},
    )
    return {"publication": pubs.public_publication(pub)}


@router.get("/publications")
async def list_publications(
    user: WsUser,
    db: MongoDb,
    start: Annotated[datetime | None, Query(alias="from")] = None,
    end: Annotated[datetime | None, Query(alias="to")] = None,
    status_: Annotated[list[str] | None, Query(alias="status")] = None,
    platform: Platform | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> dict[str, Any]:
    """Calendário: publicações num período (até 93 dias), pela data marcada."""
    query: dict[str, Any] = {"user_id": user.id}
    if start or end:
        start = _utc(start) if start else _utc(end) - MAX_RANGE
        end = _utc(end) if end else start + MAX_RANGE
        if end <= start or end - start > MAX_RANGE:
            raise ApiError(status.HTTP_422_UNPROCESSABLE_ENTITY, "range_too_long", "Período de até 93 dias.")
        query["scheduled_at"] = {"$gte": start, "$lt": end}
    if status_:
        query["status"] = {"$in": status_}
    if platform:
        query["targets.platform"] = platform
    items = await db.publications.find(query).sort("scheduled_at", 1).limit(limit).to_list()
    return {"items": await _with_details(db, user.id, items)}


async def _with_details(db: MongoDb, user_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Calendário e fila mostram miniatura, duração, tamanho e a conta de cada rede."""
    ids = {"clip": set(), "video": set()}
    for p in items:
        ids.setdefault(p["source"]["kind"], set()).add(p["source"]["id"])
    fields = {
        "duration_s": 1,
        "size": 1,
        "source_size": 1,
        "width": 1,
        "height": 1,
        "thumb_key": 1,
        "start_s": 1,
        "end_s": 1,
    }
    clips = {c["_id"]: c async for c in db.clips.find({"_id": {"$in": list(ids["clip"])}}, projection=fields)}
    videos = {
        v["_id"]: v async for v in db.videos.find({"_id": {"$in": list(ids["video"])}}, projection=fields)
    }
    accounts = {
        c["platform"]: c.get("account") or {} async for c in db.connections.find({"user_id": user_id})
    }
    out = []
    for p in items:
        kind, sid = p["source"]["kind"], p["source"]["id"]
        src = (clips if kind == "clip" else videos).get(sid) or {}
        duration = src.get("duration_s") or (
            src["end_s"] - src["start_s"] if "end_s" in src and "start_s" in src else None
        )
        public = pubs.public_publication(p)
        for t in public["targets"]:
            acc = accounts.get(t["platform"]) or {}
            t["account"] = acc.get("handle") or acc.get("name")
        out.append(
            public
            | {
                "thumbnail_url": f"/api/v1/{kind}s/{sid}/media/thumbnail" if src.get("thumb_key") else None,
                "duration_s": duration,
                "size_bytes": src.get("size") or src.get("source_size"),
                "width": src.get("width"),
                "height": src.get("height"),
            }
        )
    return out


@router.get("/publications/{pub_id}")
async def get_publication(pub_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    return {"publication": pubs.public_publication(await _owned(db, pub_id, user.id))}


@router.patch("/publications/{pub_id}")
async def edit_publication(
    pub_id: str, body: PublicationPatch, user: WsPublisher, db: MongoDb
) -> dict[str, Any]:
    """Editar textos e redes ou reagendar (arrastar no calendário). Só rascunho ou agendada."""
    pub = await _owned(db, pub_id, user.id)
    if pub["status"] not in pubs.EDITABLE:
        raise ApiError(status.HTTP_409_CONFLICT, "not_editable", "Esta publicação já saiu ou está saindo.")
    fields: dict[str, Any] = {}
    if body.title is not None:
        fields["title"] = " ".join(body.title.split())
    if body.timezone is not None:
        fields["timezone"] = body.timezone
    if body.targets is not None:
        title = fields.get("title", pub["title"])
        current = {t["platform"]: t for t in pub["targets"]}
        base = next(iter(current.values()))
        fields["targets"] = _targets(body.targets, title, base["description"], base.get("tags", []))
        for t in fields["targets"]:
            # Campo não informado mantém o que já estava naquela rede.
            old = current.get(t["platform"])
            src = next(x for x in body.targets if x.platform == t["platform"])
            if old:
                for key in ("title", "description", "tags", "privacy"):
                    if getattr(src, key) is None:
                        t[key] = old[key]
    if body.scheduled_at is not None:
        when = ScheduleFields(
            scheduled_at=body.scheduled_at, timezone=fields.get("timezone", pub["timezone"])
        ).when()
        _check_when(when)
        fields["scheduled_at"] = when
    if not fields:
        return {"publication": pubs.public_publication(pub)}
    source = await _source_or_422(db, user.id, pub)
    await _validate(
        db, user.id, source, fields.get("targets", pub["targets"]), connected=pub["status"] == "scheduled"
    )
    fields["updated_at"] = _now()
    updated = await db.publications.find_one_and_update(
        {"_id": pub_id, "status": {"$in": list(pubs.EDITABLE)}},
        {"$set": fields},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise ApiError(status.HTTP_409_CONFLICT, "not_editable", "Esta publicação acabou de sair.")
    rescheduled = "scheduled_at" in fields and fields["scheduled_at"] != pub.get("scheduled_at")
    await record(
        "publication",
        "publication.rescheduled" if rescheduled else "publication.edited",
        "Publicação reagendada" if rescheduled else "Publicação editada",
        outcome="success",
        details={
            "publication_id": pub_id,
            "from": pub["scheduled_at"].isoformat() if pub.get("scheduled_at") else None,
            "to": fields["scheduled_at"].isoformat() if "scheduled_at" in fields else None,
        },
    )
    return {"publication": pubs.public_publication(updated)}


async def _source_or_422(db: MongoDb, user_id: str, pub: dict[str, Any]) -> dict[str, Any]:
    try:
        return await pubs.load_source(db, user_id, pub["source"]["kind"], pub["source"]["id"])
    except pubs.PublicationError as exc:
        raise _error(exc) from exc


@router.post("/publications/{pub_id}/schedule")
async def schedule_publication(
    pub_id: str, body: ScheduleIn, user: WsPublisher, db: MongoDb
) -> dict[str, Any]:
    """Rascunho → agendada (ou muda a data de uma já agendada)."""
    pub = await _owned(db, pub_id, user.id)
    if pub["status"] not in pubs.EDITABLE:
        raise ApiError(status.HTTP_409_CONFLICT, "not_editable", "Esta publicação já saiu ou está saindo.")
    when = body.when()
    _check_when(when)
    source = await _source_or_422(db, user.id, pub)
    await _validate(db, user.id, source, pub["targets"], connected=True)
    updated = await db.publications.find_one_and_update(
        {"_id": pub_id, "status": {"$in": list(pubs.EDITABLE)}},
        {
            "$set": {
                "status": "scheduled",
                "scheduled_at": when,
                "timezone": body.timezone,
                "updated_at": _now(),
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise ApiError(status.HTTP_409_CONFLICT, "not_editable", "Esta publicação acabou de sair.")
    await record(
        "publication",
        "publication.scheduled",
        "Publicação agendada",
        outcome="success",
        details={"publication_id": pub_id, "scheduled_at": when.isoformat()},
    )
    return {"publication": pubs.public_publication(updated)}


@router.post("/publications/{pub_id}/unschedule")
async def unschedule_publication(pub_id: str, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    """Agendada → rascunho (tira do calendário sem apagar)."""
    updated = await db.publications.find_one_and_update(
        {"_id": pub_id, "user_id": user.id, "status": "scheduled"},
        {"$set": {"status": "draft", "updated_at": _now()}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        await _owned(db, pub_id, user.id)
        raise ApiError(status.HTTP_409_CONFLICT, "not_scheduled", "Esta publicação não está agendada.")
    await record(
        "publication", "publication.unscheduled", "Agendamento desfeito", details={"publication_id": pub_id}
    )
    return {"publication": pubs.public_publication(updated)}


async def _flip(db: MongoDb, user: Any, pub_id: str, src: str, dst: str) -> dict[str, Any]:
    updated = await db.publications.find_one_and_update(
        {"_id": pub_id, "user_id": user.id, "status": src},
        {"$set": {"status": dst, "updated_at": datetime.now(UTC)}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        await _owned(db, pub_id, user.id)
        message = (
            "Esta publicação não está agendada."
            if src == "scheduled"
            else "Esta publicação não está pausada."
        )
        raise ApiError(status.HTTP_409_CONFLICT, f"not_{src}", message)
    await record(
        "publication",
        f"publication.{'paused' if dst == 'paused' else 'resumed'}",
        "Publicação pausada" if dst == "paused" else "Publicação retomada",
        details={"publication_id": pub_id},
    )
    return {"publication": pubs.public_publication(updated)}


@router.post("/publications/{pub_id}/pause")
async def pause_publication(pub_id: str, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    """Tira da fila sem perder o horário. Ao retomar, se o horário já passou, sai no próximo minuto."""
    return await _flip(db, user, pub_id, "scheduled", "paused")


@router.post("/publications/{pub_id}/resume")
async def resume_publication(pub_id: str, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    pub = await _owned(db, pub_id, user.id)
    if pub["status"] == "paused":
        source = await _source_or_422(db, user.id, pub)
        await _validate(db, user.id, source, pub["targets"], connected=True)
    return await _flip(db, user, pub_id, "paused", "scheduled")


@router.post("/publications/{pub_id}/publish-now")
async def publish_now(pub_id: str, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    pub = await _owned(db, pub_id, user.id)
    if pub["status"] not in pubs.EDITABLE:
        raise ApiError(status.HTTP_409_CONFLICT, "not_editable", "Esta publicação já saiu ou está saindo.")
    source = await _source_or_422(db, user.id, pub)
    await _validate(db, user.id, source, pub["targets"], connected=True)
    started = await pubs.start_publishing(db, pub_id, from_status=pubs.EDITABLE, user_id=user.id)
    if started is None:
        raise ApiError(status.HTTP_409_CONFLICT, "not_editable", "Esta publicação acabou de sair.")
    await record(
        "publication", "publication.publish_now", "Publicar agora", details={"publication_id": pub_id}
    )
    return {"publication": pubs.public_publication(started)}


@router.post("/publications/{pub_id}/retry")
async def retry_publication(
    pub_id: str,
    user: WsPublisher,
    db: MongoDb,
    confirm_uncertain: bool = False,
) -> dict[str, Any]:
    """Tenta de novo as redes que falharam. Envio de resultado incerto só com confirmação."""
    pub = await _owned(db, pub_id, user.id)
    if pub["status"] not in ("failed", "partial"):
        raise ApiError(status.HTTP_409_CONFLICT, "not_failed", "Só dá para tentar de novo o que falhou.")
    failed = [t for t in pub["targets"] if t["status"] == "failed"]
    uncertain = [t["platform"] for t in failed if t.get("error_code") == "uncertain"]
    if uncertain and not confirm_uncertain:
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "confirm_uncertain",
            "Pode ser que o vídeo já esteja em "
            + ", ".join(connectors.get(p).label for p in uncertain)
            + ". Confira na rede; se não estiver, confirme para enviar de novo.",
        )
    source = await _source_or_422(db, user.id, pub)
    await _validate(db, user.id, source, failed, connected=True)
    for t in failed:
        t.update(status="pending", error=None, error_code=None, remote_id=None, url=None, remote_status=None)
    reset = await db.publications.find_one_and_update(
        {"_id": pub_id, "status": {"$in": ["failed", "partial"]}},
        {"$set": {"targets": pub["targets"], "status": "draft", "updated_at": _now()}},
    )
    if reset is None:
        raise ApiError(status.HTTP_409_CONFLICT, "not_failed", "Esta publicação mudou. Atualize a tela.")
    started = await pubs.start_publishing(db, pub_id, from_status=("draft",), user_id=user.id)
    await record(
        "publication",
        "publication.retry",
        "Nova tentativa de publicação",
        details={"publication_id": pub_id, "platforms": [t["platform"] for t in failed]},
    )
    return {"publication": pubs.public_publication(started)}


@router.post("/publications/{pub_id}/cancel")
async def cancel_publication(pub_id: str, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    """Cancela antes de sair. Se já está enviando, para o que ainda não foi (o que já foi, fica)."""
    pub = await _owned(db, pub_id, user.id)
    if pub["status"] in pubs.EDITABLE:
        updated = await db.publications.find_one_and_update(
            {"_id": pub_id, "status": {"$in": list(pubs.EDITABLE)}},
            {"$set": {"status": "cancelled", "updated_at": _now()}},
            return_document=ReturnDocument.AFTER,
        )
        if updated is None:
            pub = await _owned(db, pub_id, user.id)
        else:
            await record(
                "publication",
                "publication.cancelled",
                "Publicação cancelada",
                details={"publication_id": pub_id},
            )
            return {"publication": pubs.public_publication(updated)}
    if pub["status"] == "publishing" and pub.get("job_id"):
        job = await jobs.request_cancel(db, pub["job_id"], user.id)
        if job and job["status"] == "cancelled":
            # Estava esperando na fila (nova tentativa): nenhum worker vai rodar, fecha aqui.
            await pubs.on_job_failed(db, job, "cancelled")
        await record(
            "publication",
            "publication.cancel_requested",
            "Cancelamento pedido durante o envio",
            details={"publication_id": pub_id},
        )
        return {"publication": pubs.public_publication(await _owned(db, pub_id, user.id))}
    raise ApiError(status.HTTP_409_CONFLICT, "not_cancellable", "Esta publicação já terminou.")


@router.delete("/publications/{pub_id}")
async def delete_publication(pub_id: str, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    """Apaga o registro (não apaga nada nas redes; para isso, use a exclusão por rede)."""
    pub = await _owned(db, pub_id, user.id)
    if pub["status"] == "publishing":
        raise ApiError(status.HTTP_409_CONFLICT, "publishing", "Espere terminar de enviar ou cancele antes.")
    await db.publications.delete_one({"_id": pub_id, "status": {"$ne": "publishing"}})
    await record(
        "publication",
        "publication.deleted",
        "Publicação apagada do Clipo",
        details={"publication_id": pub_id},
    )
    return {"message": "Publicação apagada."}


@router.delete("/publications/{pub_id}/targets/{platform}/remote")
async def delete_remote(pub_id: str, platform: Platform, user: WsPublisher, db: MongoDb) -> dict[str, Any]:
    """Apaga o vídeo publicado na rede (quando a API da rede permite)."""
    pub = await _owned(db, pub_id, user.id)
    target = next((t for t in pub["targets"] if t["platform"] == platform), None)
    if target is None or not target.get("remote_id"):
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Nada publicado nessa rede.")
    connector = connectors.get(platform)
    try:
        conn, tokens = await connections.access(db, user.id, platform)
        await connector.delete(tokens, conn["account"], target["remote_id"])
    except NotSupported as exc:
        raise ApiError(status.HTTP_422_UNPROCESSABLE_ENTITY, "not_supported", exc.message) from exc
    except ConnectorError as exc:
        await record(
            "publication",
            "target.delete_failed",
            exc.message[:300],
            level="error",
            outcome="failure",
            platform=platform,
            details={"publication_id": pub_id},
        )
        raise ApiError(status.HTTP_502_BAD_GATEWAY, exc.code, exc.message) from exc
    await db.publications.update_one(
        {"_id": pub_id, "targets.platform": platform},
        {"$set": {"targets.$.status": "removed", "targets.$.removed_at": _now(), "updated_at": _now()}},
    )
    await record(
        "publication",
        "target.removed",
        f"Vídeo apagado no {connector.label}",
        outcome="success",
        platform=platform,
        details={"publication_id": pub_id, "remote_id": target["remote_id"]},
    )
    return {"publication": pubs.public_publication(await _owned(db, pub_id, user.id))}


# ---------------------------------------------------------------- avisos (sino)


@router.get("/notifications")
async def list_notifications(
    user: AuthUser,
    db: MongoDb,
    unread: bool = False,
    before: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> dict[str, Any]:
    query: dict[str, Any] = {"user_id": user.id}
    if unread:
        query["read_at"] = None
    if before:
        query["created_at"] = {"$lt": _utc(before)}
    items = await db.notifications.find(query).sort("created_at", -1).limit(limit).to_list()
    unread_count = await db.notifications.count_documents({"user_id": user.id, "read_at": None})
    return {
        "items": [public_notification(n) for n in items],
        "unread": unread_count,
        "next_before": items[-1]["created_at"].isoformat() if len(items) == limit else None,
    }


@router.post("/notifications/{notification_id}/read")
async def read_notification(notification_id: str, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    result = await db.notifications.update_one(
        {"_id": notification_id, "user_id": user.id, "read_at": None}, {"$set": {"read_at": _now()}}
    )
    if not result.matched_count and not await db.notifications.find_one(
        {"_id": notification_id, "user_id": user.id}, projection={"_id": 1}
    ):
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Aviso não encontrado.")
    return {"ok": True}


@router.post("/notifications/read-all")
async def read_all_notifications(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    result = await db.notifications.update_many(
        {"user_id": user.id, "read_at": None}, {"$set": {"read_at": _now()}}
    )
    return {"marked": result.modified_count}

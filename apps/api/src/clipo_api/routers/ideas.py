"""API v1 de ideias e roteiros: banco de ideias, geração com IA, editor de roteiro e teleprompter."""

import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, Field

from clipo_api.core.errors import ApiError
from clipo_api.core.ratelimit import hit
from clipo_api.core.workspace import WsUser, WsWriter
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import record
from clipo_api.services import analytics
from clipo_api.services.ai import creative

router = APIRouter(prefix="/api/v1", tags=["ideias e roteiros"])

IdeaCategory = Literal["viral", "conversion", "educational"]
IdeaStatus = Literal["available", "scripted", "in_production"]
Effort = Literal["low", "medium", "high"]
Net = Literal["tiktok", "instagram", "youtube", "linkedin"]
ScriptStatus = Literal["draft", "ready", "recorded"]
DEFAULT_WPM = 160


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


# ---------------------------------------------------------------- ideias


def public_idea(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": doc["_id"],
        "title": doc["title"],
        "hook": doc.get("hook", ""),
        "category": doc.get("category", "viral"),
        "niche": doc.get("niche", ""),
        "format": doc.get("format", ""),
        "duration_s": doc.get("duration_s"),
        "effort": doc.get("effort", "medium"),
        "bullets": doc.get("bullets", []),
        "cta": doc.get("cta", ""),
        "platforms": doc.get("platforms", []),
        "score": doc.get("score"),
        "score_reason": doc.get("score_reason", ""),
        "saved": doc.get("saved", False),
        "status": doc.get("status", "available"),
        "source": doc.get("source", "manual"),
        "script_id": doc.get("script_id"),
        "created_at": _iso(doc["created_at"]),
    }


async def _idea(db: MongoDb, idea_id: str, user_id: str) -> dict[str, Any]:
    doc = await db.ideas.find_one({"_id": idea_id, "user_id": user_id, "deleted_at": None})
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Ideia não encontrada.")
    return doc


@router.get("/ideas")
async def list_ideas(
    user: WsUser,
    db: MongoDb,
    category: IdeaCategory | None = None,
    status_: Annotated[IdeaStatus | None, Query(alias="status")] = None,
    saved: bool | None = None,
    niche: Annotated[str | None, Query(max_length=60)] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
) -> dict[str, Any]:
    base: dict[str, Any] = {"user_id": user.id, "deleted_at": None}
    query = dict(base)
    if category:
        query["category"] = category
    if status_:
        query["status"] = status_
    if saved is not None:
        query["saved"] = saved
    if niche:
        query["niche"] = niche
    if q and q.strip():
        pattern = re.escape(q.strip())
        query["$or"] = [{f: {"$regex": pattern, "$options": "i"}} for f in ("title", "hook", "niche")]
    docs = await db.ideas.find(query).sort([("saved", -1), ("created_at", -1)]).limit(200).to_list()
    counts = {
        "all": await db.ideas.count_documents(base),
        "saved": await db.ideas.count_documents(base | {"saved": True}),
        "in_production": await db.ideas.count_documents(base | {"status": "in_production"}),
    }
    for cat in ("viral", "conversion", "educational"):
        counts[cat] = await db.ideas.count_documents(base | {"category": cat})
    niches = sorted(n for n in await db.ideas.distinct("niche", base) if n)
    return {"items": [public_idea(d) for d in docs], "counts": counts, "niches": niches}


class GenerateIn(BaseModel):
    prompt: Annotated[str, Field(max_length=300)] = ""
    niche: Annotated[str, Field(max_length=60)] = ""
    tone: Annotated[str, Field(max_length=60)] = "Direto e provocativo"
    format: Annotated[str, Field(max_length=60)] = "Shorts / Reels (até 60 s)"
    count: Annotated[int, Field(ge=1, le=5)] = 3


@router.post("/ideas/generate", status_code=status.HTTP_201_CREATED)
async def generate_ideas(body: GenerateIn, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    await hit(db, "ai:user", user.id, limit=60, window_seconds=3600)
    top = await analytics.top_titles(db, user.id, 5)
    existing = [d["title"] async for d in db.ideas.find({"user_id": user.id, "deleted_at": None}).limit(30)]
    (generated, call_id), usage = await creative.paid(
        db,
        user.id,
        "ideas",
        "ideias",
        lambda: creative.ideas(
            db,
            user.id,
            count=body.count,
            niche=body.niche,
            prompt=body.prompt,
            tone=body.tone,
            fmt=body.format,
            top=top,
            existing=existing,
        ),
    )
    now = _now()
    docs = [
        {
            "_id": uuid4().hex,
            "user_id": user.id,
            "created_by": user.actor_id,
            **idea.model_dump(),
            "bullets": idea.bullets[:5],
            "niche": body.niche,
            "format": body.format,
            "saved": False,
            "status": "available",
            "source": "ai",
            "call_id": call_id,
            "deleted_at": None,
            "created_at": now,
            "updated_at": now,
        }
        for idea in generated
    ]
    if docs:
        await db.ideas.insert_many(docs)
    await record("content", "ideas.generated", f"{len(docs)} ideia(s) geradas pela IA", outcome="success")
    return {"items": [public_idea(d) for d in docs], "credits": usage}


class IdeaIn(BaseModel):
    title: Annotated[str, Field(min_length=1, max_length=200)]
    hook: Annotated[str, Field(max_length=500)] = ""
    category: IdeaCategory = "viral"
    niche: Annotated[str, Field(max_length=60)] = ""
    format: Annotated[str, Field(max_length=60)] = ""
    duration_s: Annotated[int | None, Field(ge=5, le=600)] = None
    effort: Effort = "medium"
    bullets: Annotated[list[Annotated[str, Field(max_length=300)]], Field(max_length=8)] = []
    cta: Annotated[str, Field(max_length=300)] = ""
    platforms: list[Net] = []


@router.post("/ideas", status_code=status.HTTP_201_CREATED)
async def create_idea(body: IdeaIn, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    now = _now()
    doc = {
        "_id": uuid4().hex,
        "user_id": user.id,
        "created_by": user.actor_id,
        **body.model_dump(),
        "saved": True,
        "status": "available",
        "source": "manual",
        "deleted_at": None,
        "created_at": now,
        "updated_at": now,
    }
    await db.ideas.insert_one(doc)
    return {"idea": public_idea(doc)}


class IdeaPatch(BaseModel):
    title: Annotated[str | None, Field(min_length=1, max_length=200)] = None
    hook: Annotated[str | None, Field(max_length=500)] = None
    category: IdeaCategory | None = None
    niche: Annotated[str | None, Field(max_length=60)] = None
    bullets: Annotated[list[Annotated[str, Field(max_length=300)]] | None, Field(max_length=8)] = None
    cta: Annotated[str | None, Field(max_length=300)] = None
    platforms: list[Net] | None = None
    saved: bool | None = None
    status: IdeaStatus | None = None


@router.patch("/ideas/{idea_id}")
async def edit_idea(idea_id: str, body: IdeaPatch, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    await _idea(db, idea_id, user.id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    doc = await db.ideas.find_one_and_update(
        {"_id": idea_id}, {"$set": changes | {"updated_at": _now()}}, return_document=True
    )
    if "saved" in changes and doc.get("call_id"):
        # Salvar (ou descartar) uma ideia da IA é a nota da versão do prompt.
        await db.ai_calls.update_one({"_id": doc["call_id"]}, {"$set": {"feedback": bool(changes["saved"])}})
    return {"idea": public_idea(doc)}


@router.delete("/ideas/{idea_id}")
async def delete_idea(idea_id: str, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    await _idea(db, idea_id, user.id)
    await db.ideas.delete_one({"_id": idea_id})
    return {"ok": True}


@router.get("/ideas/radar")
async def idea_radar(user: WsUser, db: MongoDb) -> dict[str, Any]:
    """Temas que estão crescendo nos vídeos publicados deste workspace (dados reais das métricas)."""
    return await analytics.radar(db, user.id)


# ---------------------------------------------------------------- roteiros


def _words(text: str) -> int:
    return len(text.split())


def _blocks_out(blocks: list[dict[str, Any]], wpm: int) -> list[dict[str, Any]]:
    """Tempo de cada bloco pela quantidade de palavras faladas no ritmo do roteiro."""
    out, t = [], 0.0
    for b in blocks:
        length = _words(b.get("speech", "")) / wpm * 60
        out.append({**b, "start_s": round(t, 1), "end_s": round(t + length, 1)})
        t += length
    return out


def public_script(doc: dict[str, Any]) -> dict[str, Any]:
    wpm = doc.get("wpm", DEFAULT_WPM)
    words = sum(_words(b.get("speech", "")) for b in doc.get("blocks", []))
    return {
        "id": doc["_id"],
        "title": doc["title"],
        "hook": doc.get("hook", ""),
        "niche": doc.get("niche", ""),
        "status": doc.get("status", "draft"),
        "target_duration_s": doc.get("target_duration_s", 60),
        "wpm": wpm,
        "word_count": words,
        "estimated_duration_s": round(words / wpm * 60),
        "retention_score": doc.get("retention_score"),
        "blocks": _blocks_out(doc.get("blocks", []), wpm),
        "idea_id": doc.get("idea_id"),
        "can_undo": bool(doc.get("previous_blocks")),
        "created_at": _iso(doc["created_at"]),
        "updated_at": _iso(doc.get("updated_at")),
    }


async def _script(db: MongoDb, script_id: str, user_id: str) -> dict[str, Any]:
    doc = await db.scripts.find_one({"_id": script_id, "user_id": user_id, "deleted_at": None})
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Roteiro não encontrado.")
    return doc


def _with_ids(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keys = ("act", "speech", "visual", "emphasis", "pacing_note")
    return [
        {"id": b.get("id") or uuid4().hex[:8], **{k: (b.get(k) or "").strip() for k in keys}} for b in blocks
    ]


@router.get("/scripts")
async def list_scripts(
    user: WsUser,
    db: MongoDb,
    status_: Annotated[ScriptStatus | None, Query(alias="status")] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
) -> dict[str, Any]:
    base: dict[str, Any] = {"user_id": user.id, "deleted_at": None}
    query = dict(base)
    if status_:
        query["status"] = status_
    if q and q.strip():
        pattern = re.escape(q.strip())
        query["$or"] = [{f: {"$regex": pattern, "$options": "i"}} for f in ("title", "hook")]
    docs = await db.scripts.find(query).sort("updated_at", -1).limit(200).to_list()
    counts = {"all": await db.scripts.count_documents(base)}
    for s in ("draft", "ready", "recorded"):
        counts[s] = await db.scripts.count_documents(base | {"status": s})
    return {"items": [public_script(d) for d in docs], "counts": counts}


class BlockIn(BaseModel):
    id: Annotated[str | None, Field(max_length=20)] = None
    act: Annotated[str, Field(max_length=80)] = ""
    speech: Annotated[str, Field(max_length=3000)] = ""
    visual: Annotated[str, Field(max_length=1000)] = ""
    emphasis: Annotated[str, Field(max_length=200)] = ""
    pacing_note: Annotated[str, Field(max_length=300)] = ""


class ScriptIn(BaseModel):
    title: Annotated[str, Field(min_length=1, max_length=200)]
    hook: Annotated[str, Field(max_length=500)] = ""
    niche: Annotated[str, Field(max_length=60)] = ""
    target_duration_s: Annotated[int, Field(ge=10, le=600)] = 60
    wpm: Annotated[int, Field(ge=80, le=260)] = DEFAULT_WPM
    blocks: Annotated[list[BlockIn], Field(max_length=20)] = []


async def _insert_script(db: MongoDb, user: Any, values: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    doc = {
        "_id": uuid4().hex,
        "user_id": user.id,
        "created_by": user.actor_id,
        "status": "draft",
        "deleted_at": None,
        "created_at": now,
        "updated_at": now,
        **values,
    }
    await db.scripts.insert_one(doc)
    return doc


@router.post("/scripts", status_code=status.HTTP_201_CREATED)
async def create_script(body: ScriptIn, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    values = body.model_dump()
    values["blocks"] = _with_ids(values["blocks"]) or _with_ids(
        [{"act": "Gancho", "speech": body.hook}, {"act": "Desenvolvimento"}, {"act": "Chamada para ação"}]
    )
    doc = await _insert_script(db, user, values)
    return {"script": public_script(doc)}


@router.post("/ideas/{idea_id}/script", status_code=status.HTTP_201_CREATED)
async def script_from_idea(idea_id: str, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    """A IA escreve o roteiro falado da ideia, em blocos com fala, visual e ritmo."""
    await hit(db, "ai:user", user.id, limit=60, window_seconds=3600)
    idea = await _idea(db, idea_id, user.id)
    duration = int(idea.get("duration_s") or 60)
    (out, call_id), usage = await creative.paid(
        db,
        user.id,
        "script",
        "roteiro",
        lambda: creative.script(
            db,
            user.id,
            title=idea["title"],
            hook=idea.get("hook", ""),
            bullets=idea.get("bullets", []),
            cta=idea.get("cta", ""),
            niche=idea.get("niche", ""),
            duration_s=duration,
            wpm=DEFAULT_WPM,
        ),
    )
    doc = await _insert_script(
        db,
        user,
        {
            "title": idea["title"],
            "hook": idea.get("hook", ""),
            "niche": idea.get("niche", ""),
            "target_duration_s": duration,
            "wpm": DEFAULT_WPM,
            "blocks": _with_ids([b.model_dump() for b in out.blocks]),
            "retention_score": out.retention_score,
            "idea_id": idea_id,
            "call_id": call_id,
        },
    )
    await db.ideas.update_one({"_id": idea_id}, {"$set": {"status": "scripted", "script_id": doc["_id"]}})
    await record(
        "content", "script.generated", f"Roteiro criado pela IA: {idea['title'][:80]}", outcome="success"
    )
    return {"script": public_script(doc), "credits": usage}


@router.get("/scripts/{script_id}")
async def get_script(script_id: str, user: WsUser, db: MongoDb) -> dict[str, Any]:
    return {"script": public_script(await _script(db, script_id, user.id))}


class ScriptPatch(BaseModel):
    title: Annotated[str | None, Field(min_length=1, max_length=200)] = None
    hook: Annotated[str | None, Field(max_length=500)] = None
    niche: Annotated[str | None, Field(max_length=60)] = None
    status: ScriptStatus | None = None
    target_duration_s: Annotated[int | None, Field(ge=10, le=600)] = None
    wpm: Annotated[int | None, Field(ge=80, le=260)] = None
    blocks: Annotated[list[BlockIn] | None, Field(max_length=20)] = None


@router.patch("/scripts/{script_id}")
async def edit_script(script_id: str, body: ScriptPatch, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    current = await _script(db, script_id, user.id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if "blocks" in changes:
        changes["blocks"] = _with_ids(changes["blocks"])
    doc = await db.scripts.find_one_and_update(
        {"_id": script_id}, {"$set": changes | {"updated_at": _now()}}, return_document=True
    )
    if changes.get("status") == "recorded" and current.get("idea_id"):
        await db.ideas.update_one({"_id": current["idea_id"]}, {"$set": {"status": "in_production"}})
    return {"script": public_script(doc)}


class ScriptAIIn(BaseModel):
    action: Literal["hook", "broll", "refine", "shorten"]


@router.post("/scripts/{script_id}/ai")
async def improve_script(script_id: str, body: ScriptAIIn, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    """Gancho mais forte, B-roll concreto, fala mais natural ou mais curta. Dá para desfazer uma vez."""
    await hit(db, "ai:user", user.id, limit=60, window_seconds=3600)
    doc = await _script(db, script_id, user.id)
    if not doc.get("blocks"):
        raise ApiError(status.HTTP_409_CONFLICT, "empty_script", "Escreva pelo menos um bloco antes.")
    (out, call_id), usage = await creative.paid(
        db,
        user.id,
        "script_edit",
        "ajuste de roteiro",
        lambda: creative.edit_script(
            db,
            user.id,
            action=body.action,
            title=doc["title"],
            blocks=doc["blocks"],
            duration_s=doc.get("target_duration_s", 60),
            wpm=doc.get("wpm", DEFAULT_WPM),
        ),
    )
    new_blocks = [b.model_dump() for b in out.blocks]
    # A IA às vezes devolve menos blocos: mantém o id dos que continuam na mesma posição.
    for i, b in enumerate(new_blocks):
        if i < len(doc["blocks"]):
            b["id"] = doc["blocks"][i]["id"]
    suggestions: list[dict[str, Any]] = []
    if body.action == "broll":
        suggestions = await analytics.match_assets(db, user.id, [b["visual"] for b in new_blocks])
    doc = await db.scripts.find_one_and_update(
        {"_id": script_id},
        {
            "$set": {
                "blocks": _with_ids(new_blocks),
                "previous_blocks": doc["blocks"],
                "retention_score": out.retention_score,
                "updated_at": _now(),
            }
        },
        return_document=True,
    )
    return {
        "script": public_script(doc),
        "asset_suggestions": suggestions,
        "call_id": call_id,
        "credits": usage,
    }


@router.post("/scripts/{script_id}/undo")
async def undo_script(script_id: str, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    doc = await _script(db, script_id, user.id)
    if not doc.get("previous_blocks"):
        raise ApiError(status.HTTP_409_CONFLICT, "nothing_to_undo", "Não há mudança da IA para desfazer.")
    doc = await db.scripts.find_one_and_update(
        {"_id": script_id},
        {"$set": {"blocks": doc["previous_blocks"], "updated_at": _now()}, "$unset": {"previous_blocks": ""}},
        return_document=True,
    )
    return {"script": public_script(doc)}


@router.delete("/scripts/{script_id}")
async def delete_script(script_id: str, user: WsWriter, db: MongoDb) -> dict[str, Any]:
    doc = await _script(db, script_id, user.id)
    await db.scripts.delete_one({"_id": script_id})
    if doc.get("idea_id"):
        await db.ideas.update_one(
            {"_id": doc["idea_id"], "script_id": script_id},
            {"$set": {"status": "available"}, "$unset": {"script_id": ""}},
        )
    return {"ok": True}

"""Modelos de edição: estilo de legenda, ritmo de corte, cores e áudio salvos para reaproveitar.

A parte de legenda (`caption`) é aplicada de verdade quando a legenda é gravada no corte. O
modelo padrão do workspace vale quando o pedido de legenda não escolhe estilo.
"""

from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, Field

from clipo_api.core.errors import ApiError
from clipo_api.core.workspace import WsEditor, WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import record

router = APIRouter(prefix="/api/v1", tags=["modelos"])

Category = Literal["legendas", "ritmo", "cores", "audio"]
Aspect = Literal["9:16", "16:9", "both"]
Pacing = Literal["ultra", "rapido", "medio", "lento"]
Hex = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]

CATEGORY_LABEL = {
    "legendas": "Legenda dinâmica",
    "ritmo": "Ritmo de corte",
    "cores": "Cor e look",
    "audio": "Áudio",
}
PACING = {
    "ultra": ("Ultra rápido", 1.5),
    "rapido": ("Rápido", 2.5),
    "medio": ("Médio", 4.0),
    "lento": ("Lento", 6.0),
}


class Caption(BaseModel):
    preset: Literal["classico", "destaque", "minimal"] = "destaque"
    color: Hex = "#FFFFFF"
    highlight: Hex | None = "#FFD400"
    uppercase: bool = True
    position: Literal["bottom", "middle", "top"] = "middle"
    size: Annotated[float, Field(ge=2, le=12)] = 7.0


class TemplateIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    category: Category = "legendas"
    description: Annotated[str, Field(max_length=400)] = ""
    aspect: Aspect = "9:16"
    font_label: Annotated[str, Field(max_length=60)] = "DejaVu Sans Bold"
    animation: Annotated[str, Field(max_length=60)] = "Karaokê palavra a palavra"
    pacing: Pacing = "rapido"
    sfx: Annotated[str, Field(max_length=80)] = ""
    sample_text: Annotated[str, Field(max_length=80)] = "SEU TEXTO EM DESTAQUE"
    accent: Hex = "#1167FF"
    caption: Caption = Caption()


class TemplatePatch(BaseModel):
    name: Annotated[str | None, Field(min_length=1, max_length=80)] = None
    category: Category | None = None
    description: Annotated[str | None, Field(max_length=400)] = None
    aspect: Aspect | None = None
    font_label: Annotated[str | None, Field(max_length=60)] = None
    animation: Annotated[str | None, Field(max_length=60)] = None
    pacing: Pacing | None = None
    sfx: Annotated[str | None, Field(max_length=80)] = None
    sample_text: Annotated[str | None, Field(max_length=80)] = None
    accent: Hex | None = None
    caption: Caption | None = None


STARTERS: list[dict[str, Any]] = [
    {
        "name": "Destaque amarelo",
        "category": "legendas",
        "description": "Caixa alta no meio da tela; a palavra falada acende em amarelo. Bom para fala.",
        "font_label": "DejaVu Sans Bold",
        "animation": "Karaokê palavra a palavra",
        "pacing": "rapido",
        "sample_text": "PARE DE EDITAR NO MODO ANTIGO",
        "accent": "#FFD400",
        "caption": {"preset": "destaque", "highlight": "#FFD400", "uppercase": True, "position": "middle"},
    },
    {
        "name": "Azul Clipo",
        "category": "legendas",
        "description": "Destaque azul da marca e contorno grosso. Funciona sobre fundo claro e escuro.",
        "font_label": "DejaVu Sans Bold",
        "animation": "Karaokê palavra a palavra",
        "pacing": "ultra",
        "sample_text": "3 SEGREDOS QUE NINGUÉM CONTA",
        "accent": "#4F9DFF",
        "caption": {"preset": "destaque", "highlight": "#4F9DFF", "uppercase": True, "position": "middle"},
    },
    {
        "name": "Clássico embaixo",
        "category": "legendas",
        "description": "Texto branco com contorno, embaixo, sem efeito. Para entrevistas e vídeos longos.",
        "font_label": "DejaVu Sans Bold",
        "animation": "Sem animação",
        "pacing": "medio",
        "sample_text": "Legenda simples e legível",
        "accent": "#FFFFFF",
        "caption": {
            "preset": "classico",
            "highlight": None,
            "uppercase": False,
            "position": "bottom",
            "size": 5.5,
        },
    },
    {
        "name": "Minimal com caixa",
        "category": "legendas",
        "description": "Fundo escuro translúcido atrás do texto. Discreto, ótimo para LinkedIn.",
        "font_label": "DejaVu Sans",
        "animation": "Sem animação",
        "pacing": "lento",
        "aspect": "both",
        "sample_text": "Conteúdo com propósito",
        "accent": "#22B8F5",
        "caption": {
            "preset": "minimal",
            "highlight": None,
            "uppercase": False,
            "position": "bottom",
            "size": 4.5,
        },
    },
]


def _now() -> datetime:
    return datetime.now(UTC)


def public_template(doc: dict[str, Any]) -> dict[str, Any]:
    pacing_label, cut_seconds = PACING[doc["pacing"]]
    return {
        "id": doc["_id"],
        "name": doc["name"],
        "category": doc["category"],
        "category_label": CATEGORY_LABEL[doc["category"]],
        "description": doc.get("description", ""),
        "aspect": doc["aspect"],
        "font_label": doc.get("font_label", ""),
        "animation": doc.get("animation", ""),
        "pacing": doc["pacing"],
        "pacing_label": pacing_label,
        "cut_seconds": cut_seconds,
        "sfx": doc.get("sfx", ""),
        "sample_text": doc.get("sample_text", ""),
        "accent": doc["accent"],
        "caption": doc["caption"],
        "is_default": doc.get("is_default", False),
        "usage_count": doc.get("usage_count", 0),
        "created_at": doc["created_at"].isoformat(),
    }


async def _seed(db: MongoDb, user_id: str) -> None:
    """Workspace novo começa com alguns modelos prontos (o primeiro é o padrão)."""
    marker = await db.users.find_one_and_update(
        {"_id": user_id, "templates_seeded": {"$ne": True}}, {"$set": {"templates_seeded": True}}
    )
    if marker is None:
        return
    now = _now()
    docs = []
    for i, starter in enumerate(STARTERS):
        body = TemplateIn(**starter).model_dump()
        docs.append(
            {
                "_id": uuid4().hex,
                "user_id": user_id,
                **body,
                "is_default": i == 0,
                "usage_count": 0,
                "deleted_at": None,
                "created_at": now,
                "updated_at": now,
            }
        )
    await db.templates.insert_many(docs)


async def default_caption(db: MongoDb, user_id: str, template_id: str | None) -> dict[str, Any] | None:
    """Estilo de legenda do modelo pedido (ou do padrão). Conta um uso do modelo."""
    query: dict[str, Any] = {"user_id": user_id, "deleted_at": None}
    query |= {"_id": template_id} if template_id else {"is_default": True}
    doc = await db.templates.find_one_and_update(query, {"$inc": {"usage_count": 1}})
    if doc is None:
        if template_id:
            raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Modelo não encontrado.")
        return None
    return doc["caption"]


async def _owned(db: MongoDb, template_id: str, user_id: str) -> dict[str, Any]:
    doc = await db.templates.find_one({"_id": template_id, "user_id": user_id, "deleted_at": None})
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Modelo não encontrado.")
    return doc


@router.get("/templates")
async def list_templates(
    user: WsUser,
    db: MongoDb,
    category: Category | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
) -> dict[str, Any]:
    await _seed(db, user.id)
    query: dict[str, Any] = {"user_id": user.id, "deleted_at": None}
    if category:
        query["category"] = category
    docs = (
        await db.templates.find(query)
        .sort([("is_default", -1), ("usage_count", -1), ("created_at", 1)])
        .to_list()
    )
    items = [public_template(d) for d in docs]
    if q and q.strip():
        needle = q.strip().lower()
        items = [
            t for t in items if needle in f"{t['name']} {t['description']} {t['category_label']}".lower()
        ]
    return {"items": items}


@router.post("/templates", status_code=status.HTTP_201_CREATED)
async def create_template(body: TemplateIn, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    now = _now()
    doc = {
        "_id": uuid4().hex,
        "user_id": user.id,
        "created_by": user.actor_id,
        **body.model_dump(),
        "is_default": False,
        "usage_count": 0,
        "deleted_at": None,
        "created_at": now,
        "updated_at": now,
    }
    await db.templates.insert_one(doc)
    await record("content", "template.created", f"Modelo criado: {body.name}", outcome="success")
    return {"template": public_template(doc)}


@router.patch("/templates/{template_id}")
async def edit_template(template_id: str, body: TemplatePatch, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    await _owned(db, template_id, user.id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    doc = await db.templates.find_one_and_update(
        {"_id": template_id}, {"$set": changes | {"updated_at": _now()}}, return_document=True
    )
    return {"template": public_template(doc)}


@router.post("/templates/{template_id}/default")
async def set_default(template_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    await _owned(db, template_id, user.id)
    await db.templates.update_many({"user_id": user.id, "is_default": True}, {"$set": {"is_default": False}})
    doc = await db.templates.find_one_and_update(
        {"_id": template_id}, {"$set": {"is_default": True}}, return_document=True
    )
    return {"template": public_template(doc)}


@router.post("/templates/{template_id}/duplicate", status_code=status.HTTP_201_CREATED)
async def duplicate_template(template_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    src = await _owned(db, template_id, user.id)
    now = _now()
    doc = {
        **src,
        "_id": uuid4().hex,
        "name": f"{src['name']} (cópia)"[:80],
        "created_by": user.actor_id,
        "is_default": False,
        "usage_count": 0,
        "created_at": now,
        "updated_at": now,
    }
    await db.templates.insert_one(doc)
    return {"template": public_template(doc)}


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str, user: WsEditor, db: MongoDb) -> dict[str, Any]:
    doc = await _owned(db, template_id, user.id)
    await db.templates.delete_one({"_id": template_id})
    if doc.get("is_default"):
        # Sempre sobra um padrão, se houver modelo.
        nxt = await db.templates.find_one(
            {"user_id": user.id, "deleted_at": None}, sort=[("usage_count", -1)]
        )
        if nxt:
            await db.templates.update_one({"_id": nxt["_id"]}, {"$set": {"is_default": True}})
    return {"ok": True}

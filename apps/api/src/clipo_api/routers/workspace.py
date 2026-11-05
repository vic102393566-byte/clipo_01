"""Equipe: membros do workspace, convites por e-mail e troca do workspace ativo."""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, EmailStr, Field
from pymongo.errors import DuplicateKeyError

from clipo_api.core.auth import AuthUser
from clipo_api.core.config import get_settings
from clipo_api.core.errors import ApiError
from clipo_api.core.plans import get_plan
from clipo_api.core.ratelimit import hit
from clipo_api.core.security import hash_token, new_opaque_token
from clipo_api.core.workspace import ROLE_LABEL, WS_COOKIE, WsOwner, WsUser
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.services import email as email_service

router = APIRouter(prefix="/api/v1", tags=["equipe"])

INVITE_TTL = timedelta(days=7)
MemberRole = Literal["editor", "writer", "reviewer"]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _avatar(user: dict[str, Any] | None) -> str | None:
    return f"/media/{user['avatar_key']}" if user and user.get("avatar_key") else None


async def _last_seen(db: MongoDb, user_ids: list[str]) -> dict[str, datetime]:
    seen: dict[str, datetime] = {}
    async for row in await db.sessions.aggregate(
        [
            {"$match": {"user_id": {"$in": user_ids}}},
            {"$group": {"_id": "$user_id", "at": {"$max": "$created_at"}}},
        ]
    ):
        seen[row["_id"]] = row["at"]
    return seen


async def _seats(db: MongoDb, owner_id: str) -> tuple[int, int]:
    """(usados, limite). O dono conta como um lugar; convites pendentes também ocupam."""
    owner = await db.users.find_one({"_id": owner_id}, projection={"plan_id": 1})
    plan = await get_plan(db, (owner or {}).get("plan_id"))
    used = 1 + await db.workspace_members.count_documents({"workspace_id": owner_id})
    return used, plan.team_seats


@router.get("/workspaces")
async def list_workspaces(user: AuthUser, ws: WsUser, db: MongoDb) -> dict[str, Any]:
    """Workspaces que a pessoa pode abrir: o próprio e os que aceitou convite."""
    memberships = await db.workspace_members.find({"user_id": user.id, "status": "active"}).to_list()
    owner_ids = [user.id, *(m["workspace_id"] for m in memberships)]
    owners = {
        u["_id"]: u
        async for u in db.users.find(
            {"_id": {"$in": owner_ids}}, projection={"name": 1, "email": 1, "avatar_key": 1}
        )
    }
    roles = {user.id: "owner", **{m["workspace_id"]: m["role"] for m in memberships}}
    items = []
    for owner_id in owner_ids:
        owner = owners.get(owner_id)
        if owner is None:
            continue
        items.append(
            {
                "id": owner_id,
                "name": "Meu workspace" if owner_id == user.id else f"Workspace de {owner['name']}",
                "owner": {"name": owner["name"], "email": owner["email"], "avatar_url": _avatar(owner)},
                "role": roles[owner_id],
                "role_label": ROLE_LABEL[roles[owner_id]],
                "current": owner_id == ws.id,
            }
        )
    return {"items": items, "current": ws.id, "role": ws.ws_role, "permissions": sorted(_perms(ws))}


def _perms(ws: Any) -> set[str]:
    from clipo_api.core.workspace import PERMISSIONS

    return set(PERMISSIONS[ws.ws_role])


class SwitchIn(BaseModel):
    workspace_id: str


@router.post("/workspaces/current")
async def switch_workspace(body: SwitchIn, user: AuthUser, db: MongoDb, response: Response) -> dict[str, Any]:
    if body.workspace_id != user.id:
        member = await db.workspace_members.find_one(
            {"workspace_id": body.workspace_id, "user_id": user.id, "status": "active"}
        )
        if member is None:
            raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Você não faz parte desse workspace.")
    settings = get_settings()
    response.set_cookie(
        WS_COOKIE,
        body.workspace_id,
        max_age=365 * 24 * 3600,
        secure=settings.cookie_secure,
        samesite="lax",
        httponly=True,
        path="/",
    )
    await record(
        "workspace",
        "workspace.switched",
        "Workspace ativo trocado",
        details={"workspace_id": body.workspace_id},
    )
    return {"workspace_id": body.workspace_id}


@router.get("/workspace/members")
async def list_members(ws: WsUser, db: MongoDb) -> dict[str, Any]:
    owner = await db.users.find_one({"_id": ws.id})
    members = await db.workspace_members.find({"workspace_id": ws.id}).sort("created_at", 1).to_list()
    people = {
        u["_id"]: u
        async for u in db.users.find(
            {"_id": {"$in": [m["user_id"] for m in members if m.get("user_id")]}},
            projection={"name": 1, "email": 1, "avatar_key": 1},
        )
    }
    seen = await _last_seen(db, [ws.id, *people])
    used, limit = await _seats(db, ws.id)
    items = [
        {
            "id": "owner",
            "user_id": ws.id,
            "name": owner["name"] if owner else "",
            "email": owner["email"] if owner else "",
            "avatar_url": _avatar(owner),
            "role": "owner",
            "role_label": ROLE_LABEL["owner"],
            "status": "active",
            "joined_at": _iso(owner["created_at"]) if owner else None,
            "last_active_at": _iso(seen.get(ws.id)),
            "you": ws.actor_id == ws.id,
        }
    ]
    for m in members:
        person = people.get(m.get("user_id") or "")
        items.append(
            {
                "id": m["_id"],
                "user_id": m.get("user_id"),
                "name": person["name"] if person else m["email"].split("@")[0],
                "email": person["email"] if person else m["email"],
                "avatar_url": _avatar(person),
                "role": m["role"],
                "role_label": ROLE_LABEL[m["role"]],
                "status": m["status"],
                "joined_at": _iso(m.get("accepted_at")),
                "invited_at": _iso(m["created_at"]),
                "last_active_at": _iso(seen.get(m.get("user_id") or "")),
                "you": m.get("user_id") == ws.actor_id,
            }
        )
    return {"items": items, "seats": {"used": used, "limit": limit}, "role": ws.ws_role}


class InviteIn(BaseModel):
    email: EmailStr
    role: MemberRole


@router.post("/workspace/invites", status_code=status.HTTP_201_CREATED)
async def invite(body: InviteIn, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    await hit(db, "invite:user", ws.actor_id, limit=30, window_seconds=3600)
    email = body.email.lower()
    owner = await db.users.find_one({"_id": ws.id}, projection={"name": 1, "email": 1})
    if owner and owner["email"].lower() == email:
        raise ApiError(status.HTTP_409_CONFLICT, "already_member", "Esse e-mail é o do dono do workspace.")
    used, limit = await _seats(db, ws.id)
    if used >= limit:
        raise ApiError(
            status.HTTP_402_PAYMENT_REQUIRED,
            "team_seats_exhausted",
            f"Seu plano permite {limit} pessoa(s) no workspace, contando você. "
            "Troque de plano para convidar mais.",
        )
    token = new_opaque_token()
    now = _now()
    doc = {
        "_id": uuid4().hex,
        "workspace_id": ws.id,
        "user_id": None,
        "email": email,
        "role": body.role,
        "status": "pending",
        "invited_by": ws.actor_id,
        "token_hash": hash_token(token),
        "invite_expires_at": now + INVITE_TTL,
        "created_at": now,
    }
    try:
        await db.workspace_members.insert_one(doc)
    except DuplicateKeyError as exc:
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "already_member",
            "Essa pessoa já está no workspace ou já foi convidada.",
        ) from exc
    url = f"{get_settings().app_base_url}/convite?token={token}"
    await email_service.send_workspace_invite_email(
        email, owner["name"] if owner else "Alguém", ROLE_LABEL[body.role], url
    )
    await audit(
        "workspace.invite",
        actor_id=ws.actor_id,
        details={"workspace_id": ws.id, "email": email, "role": body.role},
    )
    await record(
        "workspace",
        "invite.sent",
        f"Convite enviado para {email}",
        outcome="success",
        details={"role": body.role},
    )
    return {"id": doc["_id"], "email": email, "role": body.role, "status": "pending"}


@router.post("/workspace/invites/{member_id}/resend")
async def resend_invite(member_id: str, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    await hit(db, "invite:user", ws.actor_id, limit=30, window_seconds=3600)
    token = new_opaque_token()
    doc = await db.workspace_members.find_one_and_update(
        {"_id": member_id, "workspace_id": ws.id, "status": "pending"},
        {"$set": {"token_hash": hash_token(token), "invite_expires_at": _now() + INVITE_TTL}},
        return_document=True,
    )
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Convite não encontrado.")
    owner = await db.users.find_one({"_id": ws.id}, projection={"name": 1})
    url = f"{get_settings().app_base_url}/convite?token={token}"
    await email_service.send_workspace_invite_email(
        doc["email"], owner["name"] if owner else "Alguém", ROLE_LABEL[doc["role"]], url
    )
    return {"ok": True}


class TokenIn(BaseModel):
    token: Annotated[str, Field(min_length=10, max_length=200)]


async def _invite_by_token(db: MongoDb, token: str) -> dict[str, Any]:
    doc = await db.workspace_members.find_one({"token_hash": hash_token(token), "status": "pending"})
    if doc is None or doc["invite_expires_at"].replace(tzinfo=UTC) < _now():
        raise ApiError(
            status.HTTP_404_NOT_FOUND, "invite_invalid", "Convite inválido ou vencido. Peça um novo."
        )
    return doc


@router.post("/workspace/invites/preview")
async def preview_invite(body: TokenIn, db: MongoDb) -> dict[str, Any]:
    """Mostra de quem é o convite antes de a pessoa entrar (não revela nada além disso)."""
    doc = await _invite_by_token(db, body.token)
    owner = await db.users.find_one({"_id": doc["workspace_id"]}, projection={"name": 1})
    return {
        "email": doc["email"],
        "role": doc["role"],
        "role_label": ROLE_LABEL[doc["role"]],
        "workspace": f"Workspace de {owner['name']}" if owner else "Workspace",
    }


@router.post("/workspace/invites/accept")
async def accept_invite(body: TokenIn, user: AuthUser, db: MongoDb, response: Response) -> dict[str, Any]:
    doc = await _invite_by_token(db, body.token)
    me = await db.users.find_one({"_id": user.id}, projection={"email": 1})
    if me is None or me["email"].lower() != doc["email"]:
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "invite_wrong_account",
            f"Este convite é para {doc['email']}. Entre com esse e-mail para aceitar.",
        )
    if doc["workspace_id"] == user.id:
        raise ApiError(status.HTTP_409_CONFLICT, "already_member", "Esse workspace já é seu.")
    await db.workspace_members.update_one(
        {"_id": doc["_id"]},
        {
            "$set": {"user_id": user.id, "status": "active", "accepted_at": _now()},
            "$unset": {"token_hash": "", "invite_expires_at": ""},
        },
    )
    await audit(
        "workspace.join", actor_id=user.id, details={"workspace_id": doc["workspace_id"], "role": doc["role"]}
    )
    await record(
        "workspace",
        "invite.accepted",
        "Convite aceito",
        outcome="success",
        details={"workspace_id": doc["workspace_id"]},
    )
    settings = get_settings()
    response.set_cookie(
        WS_COOKIE,
        doc["workspace_id"],
        max_age=365 * 24 * 3600,
        secure=settings.cookie_secure,
        samesite="lax",
        httponly=True,
        path="/",
    )
    return {"workspace_id": doc["workspace_id"], "role": doc["role"]}


class RoleIn(BaseModel):
    role: MemberRole


@router.patch("/workspace/members/{member_id}")
async def change_role(member_id: str, body: RoleIn, ws: WsOwner, db: MongoDb) -> dict[str, Any]:
    doc = await db.workspace_members.find_one_and_update(
        {"_id": member_id, "workspace_id": ws.id}, {"$set": {"role": body.role}}, return_document=True
    )
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Pessoa não encontrada no workspace.")
    await audit(
        "workspace.role", actor_id=ws.actor_id, target_user_id=doc.get("user_id"), details={"role": body.role}
    )
    return {"id": member_id, "role": body.role, "role_label": ROLE_LABEL[body.role]}


@router.delete("/workspace/members/{member_id}")
async def remove_member(member_id: str, ws: WsUser, db: MongoDb) -> dict[str, Any]:
    """O dono remove qualquer pessoa; um membro pode sair por conta própria."""
    doc = await db.workspace_members.find_one({"_id": member_id, "workspace_id": ws.id})
    if doc is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Pessoa não encontrada no workspace.")
    if not ws.is_owner and doc.get("user_id") != ws.actor_id:
        raise ApiError(
            status.HTTP_403_FORBIDDEN, "workspace_forbidden", "Só o dono do workspace remove pessoas."
        )
    await db.workspace_members.delete_one({"_id": member_id})
    await audit(
        "workspace.remove",
        actor_id=ws.actor_id,
        target_user_id=doc.get("user_id"),
        details={"workspace_id": ws.id},
    )
    await record("workspace", "member.removed", f"{doc['email']} saiu do workspace", outcome="success")
    return {"ok": True}

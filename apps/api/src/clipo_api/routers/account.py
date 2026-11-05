"""Minha conta: perfil, foto, troca de e-mail, sessões abertas, formas de entrar e LGPD."""

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, field_validator
from pymongo import ReturnDocument

from clipo_api.core.auth import AuthUser
from clipo_api.core.errors import ApiError
from clipo_api.core.permissions import Requires
from clipo_api.core.ratelimit import hit
from clipo_api.core.security import hash_password, verify_password
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.services import storage
from clipo_api.services.account_lifecycle import export_user_data
from clipo_api.services.email import send_account_deletion_email, send_email_change_email
from clipo_api.services.sessions import (
    clear_session_cookies,
    consume_email_token,
    issue_email_token,
    link,
    public_user,
    revoke,
)

router = APIRouter(prefix="/api/v1", tags=["minha conta"])

EMAIL_CHANGE_TTL = timedelta(hours=24)
AVATAR_MAX_BYTES = 5 * 1024 * 1024
AVATAR_TYPES = {"image/jpeg", "image/png", "image/webp"}
DELETE_WORD = "EXCLUIR"

Password = Annotated[str, Field(min_length=10, max_length=128)]


def _now() -> datetime:
    return datetime.now(UTC)


async def _load(db: MongoDb, user_id: str) -> dict[str, Any]:
    user = await db.users.find_one({"_id": user_id})
    if user is None:
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Entre na sua conta para continuar.")
    return user


async def _check_password(user: dict[str, Any], password: str | None) -> None:
    """Ações sensíveis pedem a senha atual de quem tem senha."""
    if not user.get("password_hash"):
        return
    if not password or not await asyncio.to_thread(verify_password, user["password_hash"], password):
        await record(
            "auth",
            "password.confirm_failed",
            "Senha atual incorreta em ação sensível",
            level="warning",
            outcome="failure",
        )
        raise ApiError(status.HTTP_400_BAD_REQUEST, "wrong_password", "A senha atual está incorreta.")


# ---------------------------------------------------------------- perfil


class Notifications(BaseModel):
    publish_success: bool = True
    publish_failure: bool = True
    storage_alert: bool = True
    product_news: bool = False


class ProfilePatch(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    locale: Literal["pt-BR", "en-US"] | None = None
    theme: Literal["dark", "light", "system"] | None = None
    notifications: Notifications | None = None

    @field_validator("name")
    @classmethod
    def _clean_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = " ".join(value.split())
        if not value:
            raise ValueError("Informe seu nome.")
        return value


def _profile(user: dict[str, Any]) -> dict[str, Any]:
    return {
        **public_user(user),
        "notifications": Notifications(**user.get("notifications", {})).model_dump(),
        "created_at": user["created_at"].isoformat(),
        "deletion_scheduled_for": user["deletion_scheduled_for"].isoformat()
        if user.get("deletion_scheduled_for")
        else None,
    }


@router.get("/account")
async def get_account(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    return {"account": _profile(await _load(db, user.id))}


@router.patch("/account")
async def update_account(body: ProfilePatch, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    changes = body.model_dump(exclude_none=True)
    if changes:
        await db.users.update_one({"_id": user.id}, {"$set": {**changes, "updated_at": _now()}})
        await record(
            "auth",
            "profile.updated",
            "Perfil atualizado",
            outcome="success",
            details={"fields": sorted(changes)},
        )
    return {"account": _profile(await _load(db, user.id))}


# ---------------------------------------------------------------- foto


class AvatarUploadIn(BaseModel):
    content_type: Annotated[str, Field(max_length=50)]
    size_bytes: Annotated[int, Field(gt=0, le=AVATAR_MAX_BYTES)]


@router.post("/account/avatar/upload-url")
async def avatar_upload_url(body: AvatarUploadIn, user: AuthUser) -> dict[str, Any]:
    if body.content_type not in AVATAR_TYPES:
        raise ApiError(status.HTTP_400_BAD_REQUEST, "unsupported_type", "Use uma imagem JPG, PNG ou WEBP.")
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[body.content_type]
    key = f"{storage.user_prefix(user.id)}avatar/{uuid4().hex}.{ext}"
    try:
        url = storage.presign_upload(key, body.content_type)
    except storage.StorageNotConfigured as exc:
        raise ApiError(503, "storage_unavailable", "Armazenamento indisponível.") from exc
    return {"key": key, "url": url}


def _is_image(head: bytes) -> bool:
    return (
        head.startswith(b"\xff\xd8\xff")
        or head.startswith(b"\x89PNG\r\n\x1a\n")
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
    )


class AvatarIn(BaseModel):
    key: Annotated[str, Field(max_length=300)]


@router.post("/account/avatar")
async def set_avatar(body: AvatarIn, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    if not body.key.startswith(f"{storage.user_prefix(user.id)}avatar/") or not storage.owns_key(
        user.id, body.key
    ):
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Imagem enviada não encontrada.")
    size = await storage.object_size(body.key)
    if not size or size > AVATAR_MAX_BYTES:
        raise ApiError(status.HTTP_400_BAD_REQUEST, "invalid_image", "A imagem precisa ter até 5 MB.")
    # Confere o conteúdo, não só o tipo declarado: os primeiros bytes de JPG, PNG ou WEBP.
    if not _is_image(await storage.read_range(body.key, 0, 11)):
        await storage.delete_object(body.key)
        raise ApiError(
            status.HTTP_400_BAD_REQUEST, "invalid_image", "O arquivo enviado não é uma imagem válida."
        )
    current = await _load(db, user.id)
    await db.users.update_one({"_id": user.id}, {"$set": {"avatar_key": body.key, "updated_at": _now()}})
    if current.get("avatar_key") and current["avatar_key"] != body.key:
        await storage.delete_object(current["avatar_key"])
    await record("auth", "avatar.updated", "Foto de perfil atualizada", outcome="success")
    return {"account": _profile(await _load(db, user.id))}


@router.delete("/account/avatar")
async def remove_avatar(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    current = await _load(db, user.id)
    if current.get("avatar_key"):
        await storage.delete_object(current["avatar_key"])
        await db.users.update_one({"_id": user.id}, {"$unset": {"avatar_key": ""}})
        await record("auth", "avatar.removed", "Foto de perfil removida", outcome="success")
    return {"account": _profile(await _load(db, user.id))}


# ---------------------------------------------------------------- troca de e-mail


class EmailChangeIn(BaseModel):
    new_email: EmailStr
    current_password: Annotated[str, Field(max_length=128)] | None = None


@router.post("/account/email", status_code=status.HTTP_202_ACCEPTED)
async def request_email_change(
    body: EmailChangeIn, user: AuthUser, db: MongoDb, tasks: BackgroundTasks
) -> dict[str, Any]:
    """A troca só acontece depois que o e-mail atual e o novo confirmarem pelo link."""
    await hit(db, "email-change:user", user.id, limit=5, window_seconds=3600)
    current = await _load(db, user.id)
    await _check_password(current, body.current_password)
    new_email = body.new_email.strip().lower()
    if new_email == current["email"]:
        raise ApiError(status.HTTP_400_BAD_REQUEST, "same_email", "Este já é o seu e-mail.")
    if await db.users.find_one({"email": new_email}, projection={"_id": 1}):
        raise ApiError(status.HTTP_409_CONFLICT, "email_taken", "Este e-mail já está em uso em outra conta.")

    change_id = uuid4().hex
    now = _now()
    await db.email_changes.delete_many({"user_id": user.id})
    await db.email_changes.insert_one(
        {
            "_id": change_id,
            "user_id": user.id,
            "old_email": current["email"],
            "new_email": new_email,
            "confirmed": [],
            "created_at": now,
            "expires_at": now + EMAIL_CHANGE_TTL,
        }
    )
    for side, address in (("old", current["email"]), ("new", new_email)):
        token = await issue_email_token(
            db, user.id, f"email_change_{side}", EMAIL_CHANGE_TTL, data={"change_id": change_id, "side": side}
        )
        tasks.add_task(
            send_email_change_email,
            address,
            link("/confirmar-email", token),
            is_new_address=side == "new",
            new_email=new_email,
        )
    await record("auth", "email_change.requested", f"Pedido de troca de e-mail para {new_email}")
    return {"message": "Enviamos um link para o e-mail atual e outro para o novo. Confirme nos dois."}


class TokenIn(BaseModel):
    token: Annotated[str, Field(min_length=20, max_length=200)]


@router.post("/account/email/confirm")
async def confirm_email_change(body: TokenIn, db: MongoDb) -> dict[str, Any]:
    """Aberto pelo link do e-mail, com ou sem sessão. Cada endereço confirma uma vez."""
    token_doc = None
    for side in ("old", "new"):
        try:
            token_doc = await consume_email_token(db, body.token, f"email_change_{side}")
            break
        except ApiError:
            continue
    if token_doc is None:
        raise ApiError(status.HTTP_400_BAD_REQUEST, "invalid_token", "Este link é inválido ou já expirou.")

    data = token_doc.get("data", {})
    change = await db.email_changes.find_one_and_update(
        {"_id": data.get("change_id"), "expires_at": {"$gt": _now()}},
        {"$addToSet": {"confirmed": data.get("side")}},
        return_document=ReturnDocument.AFTER,
    )
    if change is None:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST, "invalid_token", "Este pedido de troca expirou. Peça de novo."
        )
    if set(change["confirmed"]) != {"old", "new"}:
        await record(
            "auth",
            "email_change.confirmed_one",
            f"Troca de e-mail confirmada no endereço {data['side']}",
            user_id=change["user_id"],
        )
        return {"status": "waiting_other", "message": "Confirmado. Falta confirmar no outro e-mail."}

    if await db.users.find_one({"email": change["new_email"], "_id": {"$ne": change["user_id"]}}):
        await db.email_changes.delete_one({"_id": change["_id"]})
        raise ApiError(
            status.HTTP_409_CONFLICT, "email_taken", "Este e-mail passou a ser usado em outra conta."
        )
    await db.users.update_one(
        {"_id": change["user_id"]},
        {"$set": {"email": change["new_email"], "email_verified_at": _now(), "updated_at": _now()}},
    )
    await db.email_changes.delete_one({"_id": change["_id"]})
    await record(
        "auth",
        "email_change.done",
        f"E-mail trocado para {change['new_email']}",
        outcome="success",
        user_id=change["user_id"],
    )
    await audit(
        "email.changed",
        actor_id=change["user_id"],
        target_user_id=change["user_id"],
        details={"from": change["old_email"], "to": change["new_email"]},
    )
    return {"status": "done", "message": "E-mail trocado. Use o novo e-mail para entrar."}


# ---------------------------------------------------------------- sessões abertas


@router.get("/account/sessions")
async def list_sessions(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    """Um item por aparelho: a sessão ativa mais recente de cada família."""
    now = _now()
    docs = (
        await db.sessions.find({"user_id": user.id, "revoked_at": None, "expires_at": {"$gt": now}})
        .sort("created_at", -1)
        .to_list(200)
    )
    seen: set[str] = set()
    items = []
    for doc in docs:
        if doc["family_id"] in seen:
            continue
        seen.add(doc["family_id"])
        items.append(
            {
                "id": doc["family_id"],
                "current": doc["family_id"] == user.family_id,
                "started_at": (doc.get("started_at") or doc["created_at"]).isoformat(),
                "last_active_at": doc["created_at"].isoformat(),
                "user_agent": doc.get("user_agent", ""),
                "ip": doc.get("ip"),
                # "support": um admin vendo a conta em modo leitura (a pessoa vê e pode encerrar).
                "kind": doc.get("kind", "device"),
            }
        )
    return {"items": items}


@router.delete("/account/sessions/{family_id}")
async def revoke_session(family_id: str, user: AuthUser, db: MongoDb, response: Response) -> dict[str, Any]:
    await revoke(db, {"user_id": user.id, "family_id": family_id})
    await record(
        "auth",
        "session.revoked",
        "Sessão de um aparelho encerrada",
        details={"current": family_id == user.family_id},
    )
    if family_id == user.family_id:
        clear_session_cookies(response)
    return {"message": "Sessão encerrada."}


@router.post("/account/sessions/revoke-others")
async def revoke_other_sessions(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    await revoke(db, {"user_id": user.id, "family_id": {"$ne": user.family_id}})
    await record("auth", "session.revoked_others", "Saiu de todos os outros aparelhos")
    await audit("session.revoke_others", target_user_id=user.id)
    return {"message": "Você saiu de todos os outros aparelhos."}


# ---------------------------------------------------------------- formas de entrar


@router.get("/account/identities")
async def list_identities(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    current = await _load(db, user.id)
    return {
        "has_password": bool(current.get("password_hash")),
        "items": [
            {"provider": i["provider"], "email": i.get("email"), "linked_at": i["linked_at"].isoformat()}
            for i in current.get("identities", [])
        ],
    }


@router.delete("/account/identities/{provider}")
async def unlink_identity(provider: str, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    current = await _load(db, user.id)
    remaining = [i for i in current.get("identities", []) if i["provider"] != provider]
    if len(remaining) == len(current.get("identities", [])):
        raise ApiError(
            status.HTTP_404_NOT_FOUND, "not_found", "Esta forma de entrar não está ligada à conta."
        )
    if not remaining and not current.get("password_hash"):
        raise ApiError(
            status.HTTP_400_BAD_REQUEST,
            "last_login_method",
            "Crie uma senha antes de desligar o último jeito de entrar na conta.",
        )
    await db.users.update_one({"_id": user.id}, {"$pull": {"identities": {"provider": provider}}})
    await audit("identity.unlinked", target_user_id=user.id, details={"provider": provider})
    return {"message": "Forma de entrar removida."}


class SetPasswordIn(BaseModel):
    new_password: Password


@router.post("/account/password")
async def set_password(body: SetPasswordIn, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    """Cria a senha de uma conta que entrava só pelo Google ou pela Apple."""
    current = await _load(db, user.id)
    if current.get("password_hash"):
        raise ApiError(
            status.HTTP_409_CONFLICT, "has_password", "A conta já tem senha. Use a troca de senha."
        )
    new_hash = await asyncio.to_thread(hash_password, body.new_password)
    await db.users.update_one({"_id": user.id}, {"$set": {"password_hash": new_hash}})
    await audit("password.created", target_user_id=user.id)
    return {"message": "Senha criada. Agora você também pode entrar com e-mail e senha."}


# ---------------------------------------------------------------- LGPD


@router.get("/account/export")
async def export_account(user: AuthUser, db: MongoDb) -> JSONResponse:
    await hit(db, "export:user", user.id, limit=3, window_seconds=86400)
    data = await export_user_data(db, user.id)
    await audit("account.exported", target_user_id=user.id)
    stamp = _now().strftime("%Y%m%d")
    return JSONResponse(
        data,
        headers={"Content-Disposition": f'attachment; filename="clipo-meus-dados-{stamp}.json"'},
    )


class DeleteIn(BaseModel):
    confirmation: Annotated[str, Field(max_length=20)]
    current_password: Annotated[str, Field(max_length=128)] | None = None


@router.post("/account/delete", status_code=status.HTTP_202_ACCEPTED)
async def delete_account(
    body: DeleteIn, request: Request, user: AuthUser, db: MongoDb, response: Response, tasks: BackgroundTasks
) -> dict[str, Any]:
    """Agenda a exclusão. Durante o prazo, entrar de novo cancela; depois, tudo é apagado."""
    from clipo_api.core.config import get_settings

    if body.confirmation.strip().upper() != DELETE_WORD:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST, "confirmation_required", f"Digite {DELETE_WORD} para confirmar."
        )
    current = await _load(db, user.id)
    await _check_password(current, body.current_password)
    days = get_settings().account_deletion_grace_days
    when = _now() + timedelta(days=days)
    await db.users.update_one(
        {"_id": user.id},
        {
            "$set": {
                "status": "pending_deletion",
                "deletion_requested_at": _now(),
                "deletion_scheduled_for": when,
            }
        },
    )
    await revoke(db, {"user_id": user.id})
    clear_session_cookies(response)
    tasks.add_task(
        send_account_deletion_email,
        current["email"],
        when.strftime("%d/%m/%Y"),
        f"{get_settings().app_base_url}/login",
    )
    await record(
        "auth",
        "account.deletion_requested",
        f"Exclusão da conta agendada para {when.date()}",
        outcome="success",
        details={"grace_days": days},
    )
    await audit(
        "account.deletion_requested", target_user_id=user.id, details={"scheduled_for": when.isoformat()}
    )
    return {
        "message": f"Conta agendada para exclusão em {days} dias. Para desistir, entre de novo antes disso."
    }


# ---------------------------------------------------------------- admin: papéis


class RoleIn(BaseModel):
    role: Literal["user", "support", "admin", "super_admin"]


@router.patch("/admin/users/{user_id}/role")
async def change_role(
    user_id: str, body: RoleIn, actor: Requires("roles:manage"), db: MongoDb
) -> dict[str, Any]:
    target = await db.users.find_one({"_id": user_id})
    if target is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Usuário não encontrado.")
    if target["role"] == "super_admin" and body.role != "super_admin":
        others = await db.users.count_documents({"role": "super_admin", "_id": {"$ne": user_id}})
        if others == 0:
            raise ApiError(
                status.HTTP_400_BAD_REQUEST, "last_super_admin", "Precisa existir pelo menos um super admin."
            )
    await db.users.update_one({"_id": user_id}, {"$set": {"role": body.role}})
    # O papel vai no token de acesso: as sessões caem para o novo papel valer na hora.
    await revoke(db, {"user_id": user_id})
    await audit("role.changed", target_user_id=user_id, details={"from": target["role"], "to": body.role})
    await record(
        "admin",
        "role.changed",
        f"Papel alterado de {target['role']} para {body.role}",
        details={"target_user_id": user_id},
    )
    return {"id": user_id, "role": body.role}

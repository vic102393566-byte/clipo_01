"""Cadastro, login, renovação de sessão, saída, confirmação de e-mail e troca de senha."""

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Request, Response, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from pymongo.errors import DuplicateKeyError

from clipo_api.core.auth import AuthUser
from clipo_api.core.errors import ApiError
from clipo_api.core.middleware import REFRESH_COOKIE
from clipo_api.core.plans import FREE_PLAN_ID
from clipo_api.core.ratelimit import client_ip, hit
from clipo_api.core.security import (
    hash_password,
    hash_token,
    password_needs_rehash,
    verify_password,
)
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.services import billing
from clipo_api.services.email import send_password_reset_email, send_verification_email
from clipo_api.services.sessions import (
    clear_session_cookies as _clear_session_cookies,
)
from clipo_api.services.sessions import (
    consume_email_token as _consume_email_token,
)
from clipo_api.services.sessions import ensure_can_sign_in, public_user
from clipo_api.services.sessions import (
    issue_email_token as _issue_email_token,
)
from clipo_api.services.sessions import link as _link
from clipo_api.services.sessions import open_session as _open_session
from clipo_api.services.sessions import revoke as _revoke
from clipo_api.services.settings import user_prefs

router = APIRouter(prefix="/api/auth", tags=["autenticação"])

# Dois pedidos de renovação quase juntos (duas abas) não contam como roubo de token.
ROTATION_GRACE = timedelta(seconds=15)
VERIFY_TTL = timedelta(hours=24)
RESET_TTL = timedelta(minutes=30)

Password = Annotated[str, Field(min_length=10, max_length=128)]


def _normalize_email(value: str) -> str:
    return value.strip().lower()


class RegisterIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=120)]
    email: EmailStr
    password: Password

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Informe seu nome.")
        return value


class LoginIn(BaseModel):
    email: EmailStr
    password: Annotated[str, Field(min_length=1, max_length=128)]


class EmailIn(BaseModel):
    email: EmailStr


class TokenIn(BaseModel):
    token: Annotated[str, Field(min_length=20, max_length=200)]


class ResetIn(TokenIn):
    password: Password


class Accepted(BaseModel):
    message: str


def _now() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------- rotas


@router.post("/register", status_code=status.HTTP_202_ACCEPTED)
async def register(body: RegisterIn, request: Request, db: MongoDb, tasks: BackgroundTasks) -> Accepted:
    """Resposta igual para e-mail novo ou já cadastrado: ninguém descobre quem usa o Clipo."""
    await hit(db, "register:ip", client_ip(request), limit=10, window_seconds=3600)
    email = _normalize_email(body.email)
    user = {
        "_id": uuid4().hex,
        "email": email,
        "name": body.name,
        "password_hash": await asyncio.to_thread(hash_password, body.password),
        "role": "user",
        "plan_id": FREE_PLAN_ID,
        "email_verified_at": None,
        "created_at": _now(),
        "schema_version": 1,
    }
    try:
        await db.users.insert_one(user)
    except DuplicateKeyError:
        await record(
            "auth",
            "register.duplicate",
            f"Cadastro com e-mail já usado: {email}",
            level="warning",
            outcome="denied",
        )
    else:
        await billing.on_user_created(db, user["_id"])
        token = await _issue_email_token(db, user["_id"], "verify_email", VERIFY_TTL)
        tasks.add_task(send_verification_email, email, body.name, _link("/verificar-email", token))
        await record(
            "auth",
            "register.created",
            f"Conta criada: {email}",
            outcome="success",
            user_id=user["_id"],
            details={"ip": client_ip(request)},
        )
    return Accepted(message="Se o e-mail puder ser usado, enviamos um link de confirmação.")


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response, db: MongoDb) -> dict[str, Any]:
    email = _normalize_email(body.email)
    await hit(db, "login:ip", client_ip(request), limit=20, window_seconds=60)
    await hit(db, "login:email", email, limit=5, window_seconds=60)

    user = await db.users.find_one({"email": email})
    # verify_password gasta o mesmo tempo com ou sem usuário, para não revelar quem existe.
    if user is not None and not user.get("password_hash"):
        # Conta criada pelo Google ou pela Apple: não tem senha para conferir.
        await record(
            "auth",
            "login.failed",
            f"Login com senha em conta sem senha: {email}",
            level="warning",
            outcome="denied",
            user_id=user["_id"],
            details={"reason": "social_login_required"},
        )
        providers = (
            " ou ".join(sorted({i["provider"].capitalize() for i in user.get("identities", [])}))
            or "rede social"
        )
        raise ApiError(
            status.HTTP_400_BAD_REQUEST,
            "social_login_required",
            f"Esta conta entra com {providers}. Use o botão abaixo.",
        )
    valid = await asyncio.to_thread(verify_password, user["password_hash"] if user else None, body.password)
    if not valid or user is None:
        await record(
            "auth",
            "login.failed",
            f"Senha incorreta ou conta inexistente: {email}",
            level="warning",
            outcome="failure",
            user_id=user["_id"] if user else None,
            details={
                "reason": "invalid_credentials",
                "account_exists": user is not None,
                "ip": client_ip(request),
            },
        )
        raise ApiError(
            status.HTTP_401_UNAUTHORIZED,
            "invalid_credentials",
            "E-mail ou senha incorretos.",
        )
    if user.get("email_verified_at") is None:
        await record(
            "auth",
            "login.failed",
            f"Login com e-mail não confirmado: {email}",
            level="warning",
            outcome="denied",
            user_id=user["_id"],
            details={"reason": "email_not_verified"},
        )
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "email_not_verified",
            "Confirme seu e-mail para entrar. Procure o link na sua caixa de entrada.",
        )
    await ensure_can_sign_in(db, user)
    if password_needs_rehash(user["password_hash"]):
        new_hash = await asyncio.to_thread(hash_password, body.password)
        await db.users.update_one({"_id": user["_id"]}, {"$set": {"password_hash": new_hash}})

    await _open_session(db, request, response, user)
    await record(
        "auth",
        "login.success",
        f"Login: {email}",
        outcome="success",
        user_id=user["_id"],
        details={"ip": client_ip(request), "user_agent": request.headers.get("user-agent", "")[:200]},
    )
    return {"user": public_user(user)}


@router.post("/refresh")
async def refresh(request: Request, response: Response, db: MongoDb) -> dict[str, Any]:
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise ApiError(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "Entre na sua conta para continuar.",
        )
    await hit(db, "refresh:ip", client_ip(request), limit=60, window_seconds=60)

    now = _now()
    token_hash = hash_token(token)
    # Gira o token numa operação atômica: só um pedido consegue usar cada token.
    session = await db.sessions.find_one_and_update(
        {"token_hash": token_hash, "revoked_at": None, "expires_at": {"$gt": now}},
        {"$set": {"revoked_at": now}},
    )
    if session is None:
        used = await db.sessions.find_one({"token_hash": token_hash})
        if used and used.get("revoked_at") and now - used["revoked_at"] < ROTATION_GRACE:
            # Outra aba acabou de renovar e os cookies novos já estão no navegador.
            raise ApiError(
                status.HTTP_409_CONFLICT,
                "session_rotated",
                "Sessão renovada. Repita o pedido.",
            )
        if used:
            # Token já girado voltou a ser usado: sinal de roubo. Todas as sessões da pessoa caem.
            await _revoke(db, {"user_id": used["user_id"]})
            await record(
                "auth",
                "refresh.reuse_detected",
                "Token de renovação antigo reutilizado: todas as sessões da conta foram encerradas",
                level="error",
                outcome="denied",
                user_id=used["user_id"],
                details={"ip": client_ip(request)},
            )
            await audit(
                "session.revoke_all", target_user_id=used["user_id"], details={"reason": "token_reuse"}
            )
        _clear_session_cookies(response)
        raise ApiError(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "Sua sessão expirou. Entre de novo.",
        )

    user = await db.users.find_one({"_id": session["user_id"]})
    if user is None:
        raise ApiError(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "Entre na sua conta para continuar.",
        )
    if user_prefs(user)["strict_ip"] and session.get("ip") and session["ip"] != client_ip(request):
        # IP estrito: sessão aberta em outra rede não renova (vale para a próxima renovação, em até 15 min).
        await _revoke(db, {"family_id": session["family_id"]})
        await record(
            "auth",
            "refresh.ip_changed",
            "Sessão encerrada: o IP mudou e o IP estrito está ligado",
            level="warning",
            outcome="denied",
            user_id=user["_id"],
            details={"ip": client_ip(request), "previous_ip": session["ip"]},
        )
        _clear_session_cookies(response)
        raise ApiError(
            status.HTTP_401_UNAUTHORIZED, "ip_changed", "Sua rede mudou. Entre de novo para continuar."
        )
    await _open_session(
        db,
        request,
        response,
        user,
        family_id=session["family_id"],
        started_at=session.get("started_at") or session["created_at"],
    )
    return {"user": public_user(user)}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, db: MongoDb) -> Response:
    """Encerra a sessão deste aparelho mesmo com o token de acesso já vencido."""
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        session = await db.sessions.find_one({"token_hash": hash_token(token)})
        if session:
            await _revoke(db, {"family_id": session["family_id"]})
            await record("auth", "logout", "Saiu da conta", outcome="success", user_id=session["user_id"])
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_session_cookies(response)
    return response


@router.post("/verify-email")
async def verify_email(body: TokenIn, request: Request, db: MongoDb) -> Accepted:
    await hit(db, "verify:ip", client_ip(request), limit=20, window_seconds=600)
    doc = await _consume_email_token(db, body.token, "verify_email")
    await db.users.update_one(
        {"_id": doc["user_id"], "email_verified_at": None},
        {"$set": {"email_verified_at": _now()}},
    )
    await record("auth", "email.verified", "E-mail confirmado", outcome="success", user_id=doc["user_id"])
    return Accepted(message="E-mail confirmado. Você já pode entrar.")


@router.post("/resend-verification", status_code=status.HTTP_202_ACCEPTED)
async def resend_verification(
    body: EmailIn, request: Request, db: MongoDb, tasks: BackgroundTasks
) -> Accepted:
    email = _normalize_email(body.email)
    await hit(db, "resend:ip", client_ip(request), limit=10, window_seconds=3600)
    await hit(db, "resend:email", email, limit=3, window_seconds=3600)
    user = await db.users.find_one({"email": email, "email_verified_at": None})
    if user:
        token = await _issue_email_token(db, user["_id"], "verify_email", VERIFY_TTL)
        tasks.add_task(
            send_verification_email,
            email,
            user["name"],
            _link("/verificar-email", token),
        )
    return Accepted(message="Se houver uma conta pendente com este e-mail, enviamos um novo link.")


@router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(body: EmailIn, request: Request, db: MongoDb, tasks: BackgroundTasks) -> Accepted:
    email = _normalize_email(body.email)
    await hit(db, "forgot:ip", client_ip(request), limit=10, window_seconds=3600)
    await hit(db, "forgot:email", email, limit=3, window_seconds=3600)
    user = await db.users.find_one({"email": email})
    if user:
        token = await _issue_email_token(db, user["_id"], "reset_password", RESET_TTL)
        tasks.add_task(send_password_reset_email, email, _link("/redefinir-senha", token))
        await record(
            "auth", "password.reset_requested", f"Pedido de troca de senha: {email}", user_id=user["_id"]
        )
    return Accepted(message="Se houver uma conta com este e-mail, enviamos um link para trocar a senha.")


@router.post("/reset-password")
async def reset_password(body: ResetIn, request: Request, response: Response, db: MongoDb) -> Accepted:
    await hit(db, "reset:ip", client_ip(request), limit=20, window_seconds=600)
    client = request.app.state.mongo
    new_hash = await asyncio.to_thread(hash_password, body.password)
    # Senha nova, link usado e sessões antigas encerradas: ou acontece tudo, ou nada.
    async with (
        client.start_session() as mongo_session,
        await mongo_session.start_transaction(),
    ):
        doc = await db.email_tokens.find_one_and_update(
            {
                "token_hash": hash_token(body.token),
                "purpose": "reset_password",
                "used_at": None,
                "expires_at": {"$gt": _now()},
            },
            {"$set": {"used_at": _now()}},
            session=mongo_session,
        )
        if doc is None:
            raise ApiError(
                status.HTTP_400_BAD_REQUEST,
                "invalid_token",
                "Este link é inválido ou já expirou. Peça um novo.",
            )
        now = _now()
        # Quem recebeu o link provou que o e-mail é seu, então ele também fica confirmado.
        await db.users.update_one(
            {"_id": doc["user_id"]},
            [
                {
                    "$set": {
                        # $literal: o hash começa com "$" e, sem isso, o pipeline o leria como nome de campo.
                        "password_hash": {"$literal": new_hash},
                        "email_verified_at": {"$ifNull": ["$email_verified_at", now]},
                    }
                }
            ],
            session=mongo_session,
        )
        await db.sessions.update_many(
            {"user_id": doc["user_id"], "revoked_at": None},
            {"$set": {"revoked_at": now}},
            session=mongo_session,
        )
    _clear_session_cookies(response)
    await record(
        "auth",
        "password.reset",
        "Senha redefinida pelo link do e-mail",
        outcome="success",
        user_id=doc["user_id"],
    )
    await audit("password.reset", actor_id=doc["user_id"], target_user_id=doc["user_id"])
    return Accepted(message="Senha alterada. Entre com a nova senha.")


class ChangePasswordIn(BaseModel):
    current_password: Annotated[str, Field(min_length=1, max_length=128)]
    new_password: Password


@router.post("/change-password")
async def change_password(body: ChangePasswordIn, user: AuthUser, request: Request, db: MongoDb) -> Accepted:
    """Troca a senha de quem está logado. As outras sessões caem; a deste aparelho continua."""
    await hit(db, "change-password:user", user.id, limit=5, window_seconds=600)
    doc = await db.users.find_one({"_id": user.id})
    if doc is None:
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Entre na sua conta para continuar.")
    if not await asyncio.to_thread(verify_password, doc["password_hash"], body.current_password):
        await record(
            "auth",
            "password.change_failed",
            "Senha atual incorreta na troca de senha",
            level="warning",
            outcome="failure",
        )
        raise ApiError(status.HTTP_400_BAD_REQUEST, "wrong_password", "A senha atual está incorreta.")
    new_hash = await asyncio.to_thread(hash_password, body.new_password)
    await db.users.update_one({"_id": user.id}, {"$set": {"password_hash": new_hash}})
    await _revoke(db, {"user_id": user.id, "family_id": {"$ne": user.family_id}})
    await record("auth", "password.changed", "Senha trocada; outras sessões encerradas", outcome="success")
    await audit("password.changed", target_user_id=user.id)
    return Accepted(message="Senha alterada.")

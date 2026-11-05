"""Senhas, tokens de acesso e tokens opacos (renovação, e-mail)."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from clipo_api.core.config import get_settings

JWT_ALGORITHM = "HS256"
JWT_ISSUER = "clipo"
JWT_AUDIENCE = "clipo-api"

# Parâmetros padrão do argon2-cffi (RFC 9106, perfil de baixa memória).
_hasher = PasswordHasher()
# Hash de uma senha qualquer, usado para gastar o mesmo tempo quando o e-mail não existe.
_DUMMY_HASH = _hasher.hash("clipo-timing-equalizer")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def new_opaque_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """Tokens opacos ficam no banco só como SHA-256: um vazamento do banco não dá sessão a ninguém."""
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(frozen=True)
class AccessClaims:
    user_id: str
    role: str
    family_id: str
    # Admin vendo a conta de outra pessoa (só leitura): id do admin.
    impersonator_id: str | None = None


def create_access_token(
    user_id: str,
    role: str,
    family_id: str,
    *,
    impersonator_id: str | None = None,
    minutes: int | None = None,
) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    payload: dict[str, object] = {
        "sub": user_id,
        "role": role,
        "fam": family_id,
        "typ": "access",
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(minutes=minutes or settings.access_token_minutes),
    }
    if impersonator_id:
        payload["imp"] = impersonator_id
    return jwt.encode(payload, settings.jwt_secret, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> AccessClaims:
    """Levanta jwt.PyJWTError se o token for inválido, expirado ou de outro tipo."""
    claims = jwt.decode(
        token,
        get_settings().jwt_secret,
        algorithms=[JWT_ALGORITHM],
        audience=JWT_AUDIENCE,
        issuer=JWT_ISSUER,
        options={"require": ["exp", "iat", "sub", "aud", "iss"]},
    )
    if claims.get("typ") != "access":
        raise jwt.InvalidTokenError("tipo de token inválido")
    return AccessClaims(
        user_id=claims["sub"],
        role=claims.get("role", "user"),
        family_id=claims["fam"],
        impersonator_id=claims.get("imp"),
    )

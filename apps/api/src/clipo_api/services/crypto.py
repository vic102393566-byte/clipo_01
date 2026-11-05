"""Criptografia dos tokens das redes sociais no banco (Fernet, chave fora do banco)."""

import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from clipo_api.core.config import get_settings


class TokenKeyMissing(RuntimeError):
    pass


def _fernet() -> Fernet:
    key = get_settings().token_encryption_key
    if not key:
        raise TokenKeyMissing("TOKEN_ENCRYPTION_KEY não configurada")
    return Fernet(key.encode())


def encrypt(data: dict[str, Any]) -> str:
    return _fernet().encrypt(json.dumps(data).encode()).decode()


def decrypt(blob: str) -> dict[str, Any]:
    """Levanta InvalidToken se a chave mudou ou o dado foi adulterado."""
    return json.loads(_fernet().decrypt(blob.encode()))


__all__ = ["InvalidToken", "TokenKeyMissing", "decrypt", "encrypt"]

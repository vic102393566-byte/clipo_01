"""Contas de teste para desenvolvimento local. Nunca roda em produção.

Cria (ou redefine) as contas cujos e-mails e senhas estão no .env da raiz:
SEED_USER_EMAIL / SEED_USER_PASSWORD (papel user) e SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
(papel super_admin). As contas já nascem com o e-mail confirmado.

    cd apps/api && uv run python -m clipo_api.seed
"""

import asyncio
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from pymongo import AsyncMongoClient

ROOT_ENV = Path(__file__).resolve().parents[4] / ".env"


def _load_root_env() -> None:
    if not ROOT_ENV.exists():
        return
    for line in ROOT_ENV.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


async def _upsert(db, email: str, password: str, name: str, role: str) -> str:
    from clipo_api.core.security import hash_password

    now = datetime.now(UTC)
    existing = await db.users.find_one({"email": email})
    fields = {
        "name": name,
        "password_hash": hash_password(password),
        "role": role,
        "email_verified_at": existing.get("email_verified_at") if existing else now,
    }
    if existing:
        if fields["email_verified_at"] is None:
            fields["email_verified_at"] = now
        await db.users.update_one({"_id": existing["_id"]}, {"$set": fields})
        # Senha redefinida: sessões antigas dessa conta caem.
        await db.sessions.update_many(
            {"user_id": existing["_id"], "revoked_at": None}, {"$set": {"revoked_at": now}}
        )
        return "atualizada"
    await db.users.insert_one(
        {
            "_id": uuid4().hex,
            "email": email,
            "plan_id": "pro",
            "created_at": now,
            "schema_version": 1,
            **fields,
        }
    )
    return "criada"


async def main() -> int:
    _load_root_env()
    os.environ.setdefault("MONGODB_URL", "mongodb://localhost:27017/?directConnection=true")
    from clipo_api.core.config import get_settings

    settings = get_settings()
    if settings.is_production:
        print("Recusado: contas de teste não existem em produção.")
        return 1

    accounts = [
        ("SEED_USER_EMAIL", "SEED_USER_PASSWORD", "Conta de Teste", "user"),
        ("SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD", "Admin de Teste", "super_admin"),
    ]
    client = AsyncMongoClient(settings.mongodb_url, tz_aware=True)
    try:
        db = client[settings.mongodb_db]
        for email_var, password_var, name, role in accounts:
            email, password = os.environ.get(email_var, "").strip().lower(), os.environ.get(password_var, "")
            if not email or len(password) < 10:
                print(f"Pulei {email_var}: defina e-mail e senha (mín. 10 caracteres) no .env.")
                continue
            print(f"{role}: conta {await _upsert(db, email, password, name, role)} ({email_var} no .env)")
    finally:
        await client.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

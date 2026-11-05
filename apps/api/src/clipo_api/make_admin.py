"""Torna super admin uma conta que já existe (serve para produção).

Crie a conta pelo site, confirme o e-mail e rode no seu computador, apontando para o banco de
produção (a URL do Atlas fica só nesse comando, não é salva em lugar nenhum):

    cd apps/api && MONGODB_URL='mongodb+srv://...' uv run python -m clipo_api.make_admin voce@email.com

Use --role admin para dar o papel de admin em vez de super_admin.
"""

import argparse
import asyncio
import os
import sys
from datetime import UTC, datetime

from pymongo import AsyncMongoClient

ROLES = ("super_admin", "admin")


async def promote(db, email: str, role: str) -> str | None:
    user = await db.users.find_one({"email": email.strip().lower()}, {"_id": 1, "email_verified_at": 1})
    if not user:
        return None
    await db.users.update_one({"_id": user["_id"]}, {"$set": {"role": role, "updated_at": datetime.now(UTC)}})
    return "confirmado" if user.get("email_verified_at") else "sem confirmar"


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dá o papel de administrador a uma conta do Clipo.")
    parser.add_argument("email")
    parser.add_argument("--role", choices=ROLES, default="super_admin")
    args = parser.parse_args(argv)
    url = os.environ.get("MONGODB_URL") or os.environ.get("MONGODB_URI")
    if not url:
        print("Defina MONGODB_URL com a URL do banco (ex.: a do Atlas).")
        return 2
    client = AsyncMongoClient(url, tz_aware=True)
    try:
        status = await promote(client[os.environ.get("MONGODB_DB", "clipo")], args.email, args.role)
    finally:
        await client.close()
    if status is None:
        print("Conta não encontrada. Cadastre-se pelo site primeiro.")
        return 1
    print(f"Pronto: a conta agora é {args.role} (e-mail {status}). Saia e entre de novo no Clipo.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

"""Feature flags: ligar uma função para todos, para alguns planos, para algumas pessoas ou para
uma porcentagem das contas (sempre as mesmas, pelo id), sem subir código.

Ordem: desligada → ninguém; pessoa na lista → sim; plano fora da lista → não; porcentagem.
"""

import hashlib
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase


def _bucket(key: str, user_id: str) -> int:
    return int(hashlib.sha256(f"{key}:{user_id}".encode()).hexdigest(), 16) % 100


def evaluate(flag: dict[str, Any], user_id: str, plan_id: str | None) -> bool:
    if not flag.get("enabled"):
        return False
    if user_id in (flag.get("user_ids") or []):
        return True
    if flag.get("plan_ids") and plan_id not in flag["plan_ids"]:
        return False
    return _bucket(flag["_id"], user_id) < int(flag.get("rollout_percent", 100))


async def for_user(db: AsyncDatabase, user_id: str, plan_id: str | None) -> dict[str, bool]:
    flags = await db.feature_flags.find({}).to_list(500)
    return {f["_id"]: evaluate(f, user_id, plan_id) for f in flags}


async def enabled(db: AsyncDatabase, key: str, user_id: str, plan_id: str | None) -> bool:
    flag = await db.feature_flags.find_one({"_id": key})
    return bool(flag) and evaluate(flag, user_id, plan_id)

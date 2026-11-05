"""Webhooks de saída: avisam um sistema da pessoa (n8n, Zapier, servidor próprio) quando algo acontece.

Cada entrega vira um job `webhook.deliver` (até 5 tentativas). O corpo vai assinado:
`X-Clipo-Signature: sha256=<HMAC-SHA256 do corpo com o segredo do webhook>`.
Endereços internos (localhost, rede privada, metadados da nuvem) são recusados em produção.
"""

import asyncio
import hashlib
import hmac
import ipaddress
import json
import socket
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.config import get_settings
from clipo_api.observability.logs import record
from clipo_api.services import crypto, jobs

EVENTS = {
    "publication.published": "Publicação saiu nas redes",
    "publication.failed": "Publicação falhou",
    "video.ready": "Vídeo processado",
    "clips.ready": "Cortes prontos",
    "clip.ready": "Corte renderizado",
    "transcript.ready": "Transcrição pronta",
    "subtitles.ready": "Legendas gravadas",
}
JOB_EVENTS = {
    "video.ingest": "video.ready",
    "video.split": "clips.ready",
    "clip.render": "clip.ready",
    "video.transcribe": "transcript.ready",
    "clip.subtitles": "subtitles.ready",
}
TIMEOUT = 10.0


class UnsafeUrl(ValueError):
    pass


def _private(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise UnsafeUrl("Não encontramos esse endereço.") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return True
    return False


async def check_url(url: str) -> None:
    parsed = urlparse(url)
    production = get_settings().is_production
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise UnsafeUrl("Use um endereço http(s) completo.")
    if production and parsed.scheme != "https":
        raise UnsafeUrl("Use https: o corpo leva dados da sua conta.")
    if production and await asyncio.to_thread(_private, parsed.hostname):
        raise UnsafeUrl("Endereços internos não são permitidos.")


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def emit(db: AsyncDatabase, user_id: str, event: str, data: dict[str, Any]) -> int:
    """Cria uma entrega para cada webhook ativo que assina o evento. Nunca levanta exceção."""
    try:
        hooks = await db.webhooks.find(
            {"user_id": user_id, "active": True, "events": {"$in": [event, "*"]}}, projection={"_id": 1}
        ).to_list()
        for hook in hooks:
            await queue(db, user_id, hook["_id"], event, data)
        return len(hooks)
    except Exception:  # aviso para sistema externo não pode derrubar o fluxo principal
        return 0


async def queue(db: AsyncDatabase, user_id: str, webhook_id: str, event: str, data: dict[str, Any]) -> str:
    delivery_id = uuid4().hex
    now = datetime.now(UTC)
    payload = {"id": delivery_id, "event": event, "created_at": now.isoformat(), "data": data}
    await db.webhook_deliveries.insert_one(
        {
            "_id": delivery_id,
            "user_id": user_id,
            "webhook_id": webhook_id,
            "event": event,
            "payload": payload,
            "status": "pending",
            "attempts": 0,
            "created_at": now,
        }
    )
    await jobs.enqueue(
        db,
        "webhook.deliver",
        user_id,
        {"delivery_id": delivery_id},
        max_attempts=5,
        job_id=f"wh-{delivery_id}",
    )
    return delivery_id


async def deliver(ctx: Any) -> dict[str, Any]:
    from clipo_api.services.processing import PermanentError

    db = ctx.db
    delivery = await db.webhook_deliveries.find_one({"_id": ctx.job["payload"]["delivery_id"]})
    if delivery is None:
        return {"skipped": "entrega removida"}
    hook = await db.webhooks.find_one({"_id": delivery["webhook_id"]})
    if hook is None or not hook.get("active"):
        await db.webhook_deliveries.update_one({"_id": delivery["_id"]}, {"$set": {"status": "skipped"}})
        return {"skipped": "webhook pausado ou removido"}
    try:
        await check_url(hook["url"])
    except UnsafeUrl as exc:
        await db.webhook_deliveries.update_one(
            {"_id": delivery["_id"]}, {"$set": {"status": "failed", "error": str(exc)}}
        )
        raise PermanentError(str(exc)) from exc

    body = json.dumps(delivery["payload"], ensure_ascii=False).encode()
    secret = crypto.decrypt(hook["secret"])["secret"]
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Clipo-Webhooks/1.0",
        "X-Clipo-Event": delivery["event"],
        "X-Clipo-Delivery": delivery["_id"],
        "X-Clipo-Signature": sign(secret, body),
    }
    started = time.perf_counter()
    status_code, error = None, None
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as http:
            resp = await http.post(hook["url"], content=body, headers=headers)
        status_code = resp.status_code
        if not 200 <= resp.status_code < 300:
            error = f"respondeu {resp.status_code}"
    except httpx.HTTPError as exc:
        error = f"{type(exc).__name__}: {str(exc)[:200]}"
    ms = round((time.perf_counter() - started) * 1000)
    ok = error is None
    now = datetime.now(UTC)
    await db.webhook_deliveries.update_one(
        {"_id": delivery["_id"]},
        {
            "$set": {
                "status": "delivered" if ok else "failed",
                "status_code": status_code,
                "error": error,
                "ms": ms,
            },
            "$inc": {"attempts": 1},
        },
    )
    await db.webhooks.update_one(
        {"_id": hook["_id"]},
        {
            "$set": {"last_triggered_at": now, "last_status": status_code, "last_error": error},
            "$inc": {"success_count" if ok else "failure_count": 1},
        },
    )
    if not ok:
        await record(
            "webhook",
            "outgoing.failed",
            f"Webhook {hook['name']} falhou: {error}",
            level="warning",
            outcome="failure",
            user_id=hook["user_id"],
            details={"webhook_id": hook["_id"], "event": delivery["event"], "ms": ms},
        )
        raise RuntimeError(error)  # o worker tenta de novo com espera crescente
    return {"status_code": status_code, "ms": ms}

"""Publicações: um vídeo (ou corte) que vai para uma ou mais redes, agora ou numa data marcada.

Estados da publicação: draft (rascunho) → scheduled (agendada) → publishing (publicando) →
published (publicada) | partial (saiu em parte das redes) | failed (falhou) | cancelled.

Cada rede é um "alvo" com estado próprio: pending → uploading → processing → published | failed.

Nunca publica duas vezes:
- O agendador muda a publicação para "publishing" numa operação atômica e só então cria o job,
  com id fixo: dois workers ao mesmo tempo não conseguem enfileirar a mesma publicação.
- O job só envia os alvos "pending". Antes de enviar, marca o alvo como "uploading".
- Se o resultado do envio é incerto (o worker caiu no meio, ou a conexão caiu sem resposta da rede),
  o alvo NÃO é enviado de novo sozinho: fica "failed" com o código "uncertain" e a pessoa confere
  na rede antes de pedir outra tentativa. Erro com resposta da rede (5xx, 429) é seguro repetir.
"""

import contextlib
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from clipo_api.observability.logs import record
from clipo_api.services import connections, connectors, jobs, notifications, storage
from clipo_api.services.connectors.base import ConnectorError, ReconnectRequired, VideoUpload

# Regras de cada rede conferidas antes de agendar (e de novo na hora de publicar).
RULES: dict[str, dict[str, Any]] = {
    "youtube": {
        "title_max": 100,
        "text_max": 5000,
        "min_s": 1,
        "max_s": 12 * 3600,
        "privacy": ("private", "unlisted", "public"),
        "default_privacy": "private",
    },
    "tiktok": {
        "title_max": 150,
        "text_max": 2200,
        "min_s": 3,
        "max_s": 10 * 60,
        "privacy": ("SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "PUBLIC_TO_EVERYONE"),
        "default_privacy": "SELF_ONLY",
    },
    "instagram": {
        "title_max": 150,
        "text_max": 2200,
        "min_s": 3,
        "max_s": 15 * 60,
        "privacy": ("public",),
        "default_privacy": "public",
    },
}
# Status das redes que querem dizer "saiu" e "não saiu".
REMOTE_DONE = {"youtube": {"processed"}, "tiktok": {"PUBLISH_COMPLETE"}, "instagram": {"PUBLISHED"}}
REMOTE_FAILED = {
    "youtube": {"failed", "rejected", "deleted", "not_found"},
    "tiktok": {"FAILED"},
    "instagram": {"ERROR", "EXPIRED"},
}
STATUS_CHECK_EVERY = timedelta(minutes=1)
STATUS_GIVE_UP = timedelta(hours=24)
EDITABLE = ("draft", "scheduled", "paused")
VERBS = {"published": "concluída", "partial": "parcial", "failed": "falhou"}
FINAL = ("published", "partial", "failed", "cancelled")


def _now() -> datetime:
    return datetime.now(UTC)


class PublicationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- origem e validação


async def load_source(db: AsyncDatabase, user_id: str, kind: str, source_id: str) -> dict[str, Any]:
    """O vídeo ou corte a publicar, pronto e fora da lixeira."""
    collection = db.videos if kind == "video" else db.clips
    doc = await collection.find_one({"_id": source_id, "user_id": user_id})
    what = "O vídeo" if kind == "video" else "O corte"
    if doc is None or doc.get("deleted_at"):
        raise PublicationError("source_unavailable", f"{what} não existe mais ou está na lixeira.")
    if doc["status"] != "ready":
        raise PublicationError("source_not_ready", f"{what} ainda não está pronto.")
    key = doc.get("source_key") if kind == "video" else doc.get("key")
    duration = (
        doc.get("duration_s") if kind == "video" else doc.get("duration_s") or doc["end_s"] - doc["start_s"]
    )
    size = doc.get("source_size") if kind == "video" else doc.get("size")
    return {"key": key, "duration_s": duration or 0, "size": size or 0, "title": doc["title"], "doc": doc}


def check_target(platform: str, target: dict[str, Any], duration_s: float) -> None:
    rules = RULES[platform]
    label = connectors.get(platform).label
    if len(target["title"]) > rules["title_max"]:
        raise PublicationError(
            "title_too_long", f"O título para o {label} pode ter até {rules['title_max']} caracteres."
        )
    if len(target["description"]) > rules["text_max"]:
        raise PublicationError(
            "text_too_long", f"O texto para o {label} pode ter até {rules['text_max']} caracteres."
        )
    if target["privacy"] not in rules["privacy"]:
        raise PublicationError("invalid_privacy", f"Privacidade inválida para o {label}.")
    if duration_s and not rules["min_s"] <= duration_s <= rules["max_s"]:
        minutes = rules["max_s"] // 60
        raise PublicationError(
            "duration_not_allowed",
            f"O {label} aceita vídeos de {rules['min_s']} s a {minutes} min. Este tem {round(duration_s)} s.",
        )


async def check_connected(db: AsyncDatabase, user_id: str, platform: str) -> None:
    conn = await db.connections.find_one({"_id": connections.connection_id(user_id, platform)})
    label = connectors.get(platform).label
    if conn is None:
        raise PublicationError("not_connected", f"Conecte o {label} antes de agendar.")
    if conn["status"] == "needs_reconnect":
        raise PublicationError("reconnect_required", f"A conexão com o {label} expirou. Conecte de novo.")
    if not await connections.within_plan(db, user_id, platform):
        raise PublicationError(
            "plan_limit", f"Seu plano não inclui mais o {label}. Mude de plano ou desconecte outra rede."
        )


def new_target(platform: str, title: str, description: str, tags: list[str], privacy: str | None) -> dict:
    return {
        "platform": platform,
        "title": title,
        "description": description,
        "tags": tags,
        "privacy": privacy or RULES[platform]["default_privacy"],
        "status": "pending",
        "remote_id": None,
        "url": None,
        "remote_status": None,
        "error": None,
        "error_code": None,
        "uploaded_at": None,
        "published_at": None,
        "next_check_at": None,
    }


def local_time(when: datetime | None, tz: str) -> str | None:
    return when.astimezone(ZoneInfo(tz)).isoformat() if when else None


def public_publication(p: dict[str, Any]) -> dict[str, Any]:
    tz = p.get("timezone") or "UTC"
    return {
        "id": p["_id"],
        "source": p["source"],
        "title": p["title"],
        "status": p["status"],
        "timezone": tz,
        "scheduled_at": p["scheduled_at"].isoformat() if p.get("scheduled_at") else None,
        "scheduled_local": local_time(p.get("scheduled_at"), tz),
        "targets": [
            {
                k: (v.isoformat() if isinstance(v, datetime) else v)
                for k, v in t.items()
                if k != "next_check_at"
            }
            for t in p["targets"]
        ],
        "job_id": p.get("job_id"),
        "attempts": p.get("attempts", 0),
        "created_at": p["created_at"].isoformat(),
        "updated_at": p["updated_at"].isoformat(),
        "published_at": p["published_at"].isoformat() if p.get("published_at") else None,
    }


# ---------------------------------------------------------------- enfileirar


async def _enqueue_for(db: AsyncDatabase, pub: dict[str, Any]) -> None:
    with contextlib.suppress(DuplicateKeyError):
        await jobs.enqueue(
            db, "publication.publish", pub["user_id"], {"publication_id": pub["_id"]}, job_id=pub["job_id"]
        )


async def start_publishing(
    db: AsyncDatabase, publication_id: str, *, from_status: tuple[str, ...], user_id: str | None = None
) -> dict[str, Any] | None:
    """Passa para "publishing" e cria o job, numa troca atômica (só um processo consegue)."""
    query: dict[str, Any] = {"_id": publication_id, "status": {"$in": list(from_status)}}
    if user_id:
        query["user_id"] = user_id
    if from_status == ("scheduled",):
        query["scheduled_at"] = {"$lte": _now()}
    pub = await db.publications.find_one_and_update(
        query,
        {
            "$set": {
                "status": "publishing",
                "job_id": f"pub-{publication_id}-{uuid4().hex[:8]}",
                "updated_at": _now(),
            },
            "$inc": {"attempts": 1},
        },
        return_document=ReturnDocument.AFTER,
    )
    if pub:
        await _enqueue_for(db, pub)
    return pub


async def schedule_due(db: AsyncDatabase, limit: int = 50) -> int:
    """Agendador (a cada minuto no worker): publica o que venceu."""
    from clipo_api.services.settings import paused_workspaces

    # Workspace com a automação desligada: o que venceu continua na fila até religar.
    paused = await paused_workspaces(db)
    count = 0
    for _ in range(limit):
        due = await db.publications.find_one(
            {"status": "scheduled", "scheduled_at": {"$lte": _now()}, "user_id": {"$nin": paused}},
            sort=[("scheduled_at", 1)],
        )
        if due is None:
            break
        pub = await start_publishing(db, due["_id"], from_status=("scheduled",))
        if pub:
            count += 1
            late = (_now() - pub["scheduled_at"]).total_seconds()
            await record(
                "publication",
                "publication.due",
                f"Publicação agendada entrou na fila ({', '.join(t['platform'] for t in pub['targets'])})",
                user_id=pub["user_id"],
                details={"publication_id": pub["_id"], "late_seconds": round(late), "job_id": pub["job_id"]},
            )
    # Conserto de estados presos:
    # - o processo caiu entre marcar "publishing" e criar o job → cria o job agora;
    # - o job terminou mas a publicação não fechou (caiu antes de fechar) → fecha agora.
    async for pub in db.publications.find({"status": "publishing"}, projection={"job_id": 1, "user_id": 1}):
        job = await db.jobs.find_one({"_id": pub["job_id"]})
        if job is None:
            await _enqueue_for(db, pub)
        elif job["status"] in ("failed", "cancelled"):
            await on_job_failed(db, job, job["status"])
        elif job["status"] == "done":
            await settle(db, pub["_id"])
    return count


# ---------------------------------------------------------------- publicar (job do worker)


async def _set_target(db: AsyncDatabase, pub_id: str, platform: str, **fields: Any) -> None:
    await db.publications.update_one(
        {"_id": pub_id, "targets.platform": platform},
        {"$set": {**{f"targets.$.{k}": v for k, v in fields.items()}, "updated_at": _now()}},
    )


def _apply_remote(platform: str, remote_status: str) -> str:
    if remote_status in REMOTE_DONE[platform]:
        return "published"
    if remote_status in REMOTE_FAILED[platform]:
        return "failed"
    return "processing"


async def publish(ctx: Any) -> dict[str, Any]:
    """Handler do job publication.publish. Envia os alvos pendentes, um de cada vez."""
    from clipo_api.services.processing import PermanentError

    db, pub_id = ctx.db, ctx.job["payload"]["publication_id"]
    pub = await db.publications.find_one({"_id": pub_id, "user_id": ctx.user_id})
    if pub is None or pub["status"] != "publishing":
        raise PermanentError("A publicação foi cancelada ou removida.")

    # Alvo que ficou "uploading" de uma tentativa anterior: o worker caiu no meio do envio.
    for t in pub["targets"]:
        if t["status"] == "uploading":
            await _set_target(
                db,
                pub_id,
                t["platform"],
                status="failed",
                error_code="uncertain",
                error="O envio foi interrompido e não dá para saber se chegou. "
                "Confira na rede antes de tentar de novo.",
            )
            await record(
                "publication",
                "target.uncertain",
                "Envio interrompido: resultado incerto",
                level="warning",
                outcome="failure",
                user_id=ctx.user_id,
                platform=t["platform"],
                details={"publication_id": pub_id},
            )

    pending = [t for t in pub["targets"] if t["status"] == "pending"]
    if pending:
        try:
            source = await load_source(db, ctx.user_id, pub["source"]["kind"], pub["source"]["id"])
        except PublicationError as exc:
            for t in pending:
                await _set_target(
                    db, pub_id, t["platform"], status="failed", error=exc.message, error_code=exc.code
                )
            pending = []
        else:
            path = ctx.scratch / "video.mp4"
            if not path.exists():
                await ctx.progress(5, "Baixando o vídeo")
                await storage.download(source["key"], path)

    retry_later: list[str] = []
    for index, t in enumerate(pending):
        ctx.check()
        platform = t["platform"]
        label = connectors.get(platform).label
        await ctx.progress(10 + 80 * index / len(pending), f"Enviando ao {label}")
        try:
            check_target(platform, t, source["duration_s"])
            await check_connected(db, ctx.user_id, platform)
            conn, tokens = await connections.access(db, ctx.user_id, platform)
        except PublicationError as exc:
            await _set_target(db, pub_id, platform, status="failed", error=exc.message, error_code=exc.code)
            continue
        except ReconnectRequired as exc:
            await _set_target(db, pub_id, platform, status="failed", error=exc.message, error_code=exc.code)
            continue
        except ConnectorError as exc:
            if exc.retryable:
                retry_later.append(platform)
                await _set_target(db, pub_id, platform, error=exc.message, error_code=exc.code)
            else:
                await _set_target(
                    db, pub_id, platform, status="failed", error=exc.message, error_code=exc.code
                )
            continue

        await _set_target(db, pub_id, platform, status="uploading", error=None, error_code=None)
        upload = VideoUpload(
            path=path,
            size=path.stat().st_size,
            title=t["title"],
            description=t["description"],
            tags=t.get("tags", []),
            privacy=t["privacy"],
        )
        try:
            result = await connectors.get(platform).upload(tokens, conn["account"], upload)
        except ReconnectRequired as exc:
            await connections.mark_reconnect(db, conn, exc.message)
            await _set_target(db, pub_id, platform, status="failed", error=exc.message, error_code=exc.code)
            continue
        except ConnectorError as exc:
            # A rede respondeu com erro: o envio não foi aceito.
            if exc.retryable:
                retry_later.append(platform)
                await _set_target(
                    db, pub_id, platform, status="pending", error=exc.message, error_code=exc.code
                )
            else:
                await _set_target(
                    db, pub_id, platform, status="failed", error=exc.message, error_code=exc.code
                )
            await record(
                "publication",
                "target.failed" if not exc.retryable else "target.retry",
                exc.message[:300],
                level="error" if not exc.retryable else "warning",
                outcome="failure",
                user_id=ctx.user_id,
                platform=platform,
                details={"publication_id": pub_id, "code": exc.code},
            )
            continue
        except httpx.TransportError as exc:
            # Sem resposta da rede: pode ter chegado. Não repete sozinho.
            await _set_target(
                db,
                pub_id,
                platform,
                status="failed",
                error_code="uncertain",
                error=f"A conexão com o {label} caiu durante o envio ({type(exc).__name__}). "
                "Confira na rede antes de tentar de novo.",
            )
            await record(
                "publication",
                "target.uncertain",
                f"Conexão caiu no envio ao {label}",
                level="error",
                outcome="failure",
                user_id=ctx.user_id,
                platform=platform,
                details={"publication_id": pub_id},
            )
            continue

        state = _apply_remote(platform, result.status)
        now = _now()
        await _set_target(
            db,
            pub_id,
            platform,
            status=state,
            remote_id=result.remote_id,
            url=result.url,
            remote_status=result.status,
            uploaded_at=now,
            published_at=now if state == "published" else None,
            next_check_at=now + STATUS_CHECK_EVERY if state == "processing" else None,
        )
        await record(
            "publication",
            "target.uploaded",
            f"Enviado ao {label} (status {result.status})",
            outcome="success",
            user_id=ctx.user_id,
            platform=platform,
            details={"publication_id": pub_id, "remote_id": result.remote_id, "url": result.url},
        )

    if retry_later:
        # O job volta para a fila (espera crescente) e só tenta de novo essas redes.
        raise ConnectorError("retry", f"Falha temporária em: {', '.join(retry_later)}", retryable=True)
    await settle(db, pub_id)
    return {"publication_id": pub_id}


async def on_job_failed(db: AsyncDatabase, job: dict[str, Any], outcome: str) -> None:
    """O job desistiu (tentativas esgotadas) ou foi cancelado: o que não saiu fica como falha."""
    pub_id = job["payload"]["publication_id"]
    pub = await db.publications.find_one({"_id": pub_id})
    if pub is None:
        return
    reason = "Publicação cancelada." if outcome == "cancelled" else (job.get("error") or "Falhou")
    for t in pub["targets"]:
        if t["status"] == "pending":
            await _set_target(
                db, pub_id, t["platform"], status="failed", error=t.get("error") or reason[:300]
            )
    await settle(db, pub_id)


# ---------------------------------------------------------------- estado final e avisos


async def settle(db: AsyncDatabase, pub_id: str) -> str | None:
    """Calcula o estado da publicação a partir dos alvos e avisa a pessoa quando termina."""
    pub = await db.publications.find_one({"_id": pub_id})
    if pub is None or pub["status"] not in ("publishing",):
        return None
    states = [t["status"] for t in pub["targets"]]
    if any(s in ("pending", "uploading", "processing") for s in states):
        return "publishing"
    ok = [t for t in pub["targets"] if t["status"] == "published"]
    status = "published" if len(ok) == len(states) else "partial" if ok else "failed"
    done = await db.publications.find_one_and_update(
        {"_id": pub_id, "status": "publishing"},
        {"$set": {"status": status, "published_at": _now() if ok else None, "updated_at": _now()}},
    )
    if done is None:
        return None  # outro processo já fechou
    from clipo_api.services import webhooks

    await webhooks.emit(
        db,
        pub["user_id"],
        "publication.failed" if status == "failed" else "publication.published",
        {
            "publication_id": pub_id,
            "title": pub["title"],
            "status": status,
            "targets": [
                {k: t.get(k) for k in ("platform", "status", "url", "remote_id", "error")}
                for t in pub["targets"]
            ],
        },
    )
    link = f"/publicacoes/{pub_id}"
    networks = ", ".join(connectors.get(t["platform"]).label for t in ok)
    failed = [t for t in pub["targets"] if t["status"] == "failed"]
    if ok:
        await notifications.notify(
            db,
            pub["user_id"],
            "publish_success",
            f"“{pub['title'][:80]}” foi publicado",
            f"Saiu em: {networks}.",
            link,
            dedupe_key=f"pub-ok:{pub_id}:{pub.get('attempts', 1)}",
        )
    if failed:
        details = "; ".join(
            f"{connectors.get(t['platform']).label}: {t.get('error') or 'falhou'}" for t in failed
        )
        await notifications.notify(
            db,
            pub["user_id"],
            "publish_failure",
            f"“{pub['title'][:80]}” " + ("não saiu em todas as redes" if ok else "não foi publicado"),
            details,
            link,
            dedupe_key=f"pub-fail:{pub_id}:{pub.get('attempts', 1)}",
        )
    await record(
        "publication",
        f"publication.{status}",
        f"Publicação {VERBS[status]}",
        level="info" if status == "published" else "warning" if status == "partial" else "error",
        outcome="success" if status == "published" else "failure",
        user_id=pub["user_id"],
        details={
            "publication_id": pub_id,
            "ok": [t["platform"] for t in ok],
            "failed": [t["platform"] for t in failed],
        },
    )
    return status


# ---------------------------------------------------------------- status de volta das redes


async def update_from_remote(
    db: AsyncDatabase,
    pub: dict[str, Any],
    platform: str,
    remote_status: str,
    *,
    url: str | None = None,
    reason: str | None = None,
    via: str,
) -> None:
    target = next(t for t in pub["targets"] if t["platform"] == platform)
    if target["status"] != "processing":
        return
    state = _apply_remote(platform, remote_status)
    fields: dict[str, Any] = {"remote_status": remote_status}
    if url:
        fields["url"] = url
    if state == "published":
        fields.update(status="published", published_at=_now(), next_check_at=None)
    elif state == "failed":
        fields.update(
            status="failed",
            error=reason or f"A rede recusou (status {remote_status}).",
            error_code="rejected",
            next_check_at=None,
        )
    elif target.get("uploaded_at") and _now() - target["uploaded_at"] > STATUS_GIVE_UP:
        fields.update(
            status="failed",
            error="A rede não confirmou a publicação em 24 h.",
            error_code="no_confirmation",
            next_check_at=None,
        )
    else:
        fields["next_check_at"] = _now() + STATUS_CHECK_EVERY
    await _set_target(db, pub["_id"], platform, **fields)
    if fields.get("status"):
        await record(
            "publication",
            f"target.{fields['status']}",
            f"{connectors.get(platform).label}: {remote_status} ({via})",
            level="info" if fields["status"] == "published" else "error",
            outcome="success" if fields["status"] == "published" else "failure",
            user_id=pub["user_id"],
            platform=platform,
            details={"publication_id": pub["_id"], "remote_status": remote_status, "via": via},
        )
        await settle(db, pub["_id"])


async def poll_processing(db: AsyncDatabase, limit: int = 30) -> int:
    """Consulta nas redes os envios que ainda estão processando (no máximo um por minuto cada)."""
    now = _now()
    count = 0
    cursor = db.publications.find(
        {
            "status": "publishing",
            "targets": {"$elemMatch": {"status": "processing", "next_check_at": {"$lte": now}}},
        }
    ).limit(limit)
    async for pub in cursor:
        for t in pub["targets"]:
            if t["status"] != "processing" or (t.get("next_check_at") and t["next_check_at"] > now):
                continue
            # Reserva a consulta para outro worker não consultar o mesmo ao mesmo tempo.
            claimed = await db.publications.find_one_and_update(
                {
                    "_id": pub["_id"],
                    "targets": {
                        "$elemMatch": {"platform": t["platform"], "next_check_at": t["next_check_at"]}
                    },
                },
                {"$set": {"targets.$.next_check_at": now + STATUS_CHECK_EVERY}},
            )
            if claimed is None:
                continue
            try:
                conn, tokens = await connections.access(db, pub["user_id"], t["platform"])
                result = await connectors.get(t["platform"]).status(tokens, conn["account"], t["remote_id"])
            except ConnectorError as exc:
                await record(
                    "publication",
                    "target.status_failed",
                    f"Consulta de status falhou: {exc.message}",
                    level="warning",
                    outcome="failure",
                    user_id=pub["user_id"],
                    platform=t["platform"],
                    details={"publication_id": pub["_id"]},
                )
                continue
            reason = result.extra.get("rejection") or result.extra.get("fail_reason")
            remote = result.status
            if t["platform"] == "youtube" and result.extra.get("processing") == "failed":
                remote = "failed"
            await update_from_remote(
                db, pub, t["platform"], remote, url=result.url, reason=reason, via="consulta"
            )
            count += 1
    return count


async def tiktok_event(db: AsyncDatabase, event: str, publish_id: str | None, reason: str | None) -> bool:
    """Webhook do TikTok: post.publish.complete / publicly_available / failed."""
    if not publish_id:
        return False
    pub = await db.publications.find_one(
        {"targets": {"$elemMatch": {"platform": "tiktok", "remote_id": publish_id}}}
    )
    if pub is None:
        return False
    remote = {
        "post.publish.complete": "PUBLISH_COMPLETE",
        "post.publish.publicly_available": "PUBLISH_COMPLETE",
        "post.publish.failed": "FAILED",
    }.get(event)
    if remote:
        await update_from_remote(db, pub, "tiktok", remote, reason=reason, via="webhook")
    return True

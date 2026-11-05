"""Botão de testes: confere, passo a passo, se cada rede e o webhook de pagamento funcionam.

Cada diagnóstico vira um job no worker. Cada passo grava o resultado (ok, falhou, aviso, pulado),
o tempo e a mensagem, e tudo vai para o log do sistema com o id do diagnóstico.

O que é testado, até onde a API de cada rede permite sem deixar post público:
- YouTube: envia um vídeo curto como PRIVADO, confere o processamento e APAGA.
- TikTok: envia para a caixa de RASCUNHOS do app (nada é publicado). A API não permite apagar.
- Instagram: cria o contêiner do Reel e envia o vídeo, sem publicar (não existe post privado).
- Pagamento: manda um evento de teste assinado para o próprio Clipo e um com assinatura falsa.
"""

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import httpx
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.config import get_settings
from clipo_api.observability.logs import record
from clipo_api.services import connections, connectors, jobs, media
from clipo_api.services.connectors.base import ConnectorError, NotSupported, VideoUpload

Target = Literal["youtube", "instagram", "tiktok", "payments"]
TARGETS: tuple[Target, ...] = ("youtube", "instagram", "tiktok", "payments")
StepStatus = Literal["ok", "failed", "warning", "skipped"]

TEST_TITLE = "Teste do Clipo (pode apagar)"
# Os testes trocam o transporte das chamadas do worker para a própria API.
API_TRANSPORT: httpx.AsyncBaseTransport | None = None


class StepFailed(Exception):
    pass


class Run:
    """Executa os passos em ordem e grava cada resultado no diagnóstico e no log."""

    def __init__(self, db: AsyncDatabase, diagnostic: dict[str, Any], job_id: str, total_steps: int):
        self.db = db
        self.doc = diagnostic
        self.job_id = job_id
        self.total = total_steps
        self.steps: list[dict[str, Any]] = []

    @property
    def target(self) -> str:
        return self.doc["target"]

    async def _save(self) -> None:
        await self.db.diagnostics.update_one({"_id": self.doc["_id"]}, {"$set": {"steps": self.steps}})
        done = len(self.steps)
        await jobs.progress(
            self.db, self.job_id, 100 * done / self.total, self.steps[-1]["name"] if self.steps else ""
        )

    async def step(self, name: str, fn: Callable[[], Awaitable[Any]], *, critical: bool = True) -> Any:
        started = time.perf_counter()
        status: StepStatus = "ok"
        message = ""
        result: Any = None
        try:
            result = await fn()
            if isinstance(result, tuple) and len(result) == 2 and result[0] in ("ok", "warning", "skipped"):
                status, message = result
                result = None
            elif isinstance(result, str):
                message = result
        except NotSupported as exc:
            status, message = "skipped", exc.message
        except ConnectorError as exc:
            status, message = "failed", exc.message
        except StepFailed as exc:
            status, message = "failed", str(exc)
        except Exception as exc:  # um passo nunca derruba o diagnóstico inteiro sem registrar
            status, message = "failed", f"Erro inesperado: {type(exc).__name__}"
        ms = round((time.perf_counter() - started) * 1000)
        self.steps.append({"name": name, "status": status, "message": message[:500], "ms": ms})
        await record(
            "integration",
            "diagnostic.step",
            f"[{self.target}] {name}: {status}" + (f" — {message}" if message else ""),
            level="error" if status == "failed" else "warning" if status == "warning" else "info",
            outcome="failure" if status == "failed" else "success",
            user_id=self.doc["user_id"],
            platform=self.target,
            duration_ms=ms,
            details={"diagnostic_id": self.doc["_id"], "step": name, "status": status},
        )
        await self._save()
        if status == "failed" and critical:
            raise StepFailed(name)
        return result

    def skip(self, name: str, message: str) -> None:
        self.steps.append({"name": name, "status": "skipped", "message": message, "ms": 0})


async def _test_video(scratch: Path) -> Path:
    """Vídeo vertical de 5 s (720x1280) gerado na hora: nada do usuário é enviado no teste."""
    out = scratch / "clipo-teste.mp4"
    await media.run_ffmpeg(
        [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=720x1280:rate=30:duration=5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=660:duration=5",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "-movflags",
            "+faststart",
            str(out),
        ],
        timeout=60,
        total_seconds=5,
    )
    return out


def _upload_for(path: Path, **kw: Any) -> VideoUpload:
    return VideoUpload(
        path=path,
        size=path.stat().st_size,
        title=TEST_TITLE,
        description="Vídeo de teste enviado pelo diagnóstico do Clipo.",
        tags=["clipo"],
        **kw,
    )


async def _connection_steps(run: Run, platform: str) -> tuple[dict[str, Any], dict[str, Any]]:
    connector = connectors.get(platform)
    if not connector.configured():
        await run.step(
            "Credenciais do app", lambda: _fail(f"O app do {connector.label} não está configurado no .env.")
        )

    holder: dict[str, Any] = {}

    async def conn_step() -> str:
        conn, tokens = await connections.access(run.db, run.doc["user_id"], platform)
        holder.update(conn=conn, tokens=tokens)
        expires = conn.get("access_expires_at")
        return f"Token válido até {expires:%d/%m %H:%M} UTC" if expires else "Token válido"

    await run.step("Conexão e token", conn_step)

    async def account_step() -> str:
        account = await connector.account(holder["tokens"])
        holder["account"] = {**holder["conn"]["account"], **account.as_dict()}
        return f"{account.name} ({account.handle})"

    await run.step("Conta na rede", account_step)
    return holder["tokens"], holder["account"]


async def _fail(message: str):
    raise StepFailed(message)


async def _youtube(run: Run, scratch: Path) -> None:
    yt = connectors.get("youtube")
    tokens, account = await _connection_steps(run, "youtube")
    video = await run.step("Vídeo de teste", lambda: _test_video(scratch))
    holder: dict[str, Any] = {}

    async def upload() -> str:
        result = await yt.upload(tokens, account, _upload_for(video, privacy="private"))
        holder["id"] = result.remote_id
        return f"Enviado como privado: {result.url}"

    try:
        await run.step("Envio (privado)", upload)

        async def processing():
            for _ in range(20):
                current = await yt.status(tokens, account, holder["id"])
                if current.status in ("processed", "uploaded"):
                    return "ok", f"Status {current.status} (privacidade: {current.extra.get('privacy')})"
                if current.status in ("failed", "rejected", "deleted"):
                    raise StepFailed(f"O YouTube recusou: {current.extra.get('rejection') or current.status}")
                await asyncio.sleep(3)
            return "warning", "Ainda processando depois de 60 s"

        await run.step("Processamento", processing, critical=False)
    finally:
        if holder.get("id"):

            async def delete() -> str:
                await yt.delete(tokens, account, holder["id"])
                return "Vídeo de teste apagado do canal"

            await run.step("Exclusão", delete, critical=False)


async def _tiktok(run: Run, scratch: Path) -> None:
    tt = connectors.get("tiktok")
    tokens, account = await _connection_steps(run, "tiktok")

    async def creator() -> str:
        info = await tt.creator_info(tokens)
        options = ", ".join(info.get("privacy_level_options") or []) or "nenhuma"
        max_seconds = info.get("max_video_post_duration_sec", "?")
        return f"Privacidades permitidas: {options}; duração máxima {max_seconds} s"

    await run.step("Permissões de publicação", creator, critical=False)
    video = await run.step("Vídeo de teste", lambda: _test_video(scratch))
    holder: dict[str, Any] = {}

    async def upload() -> str:
        result = await tt.upload(tokens, account, _upload_for(video, draft=True))
        holder["id"] = result.remote_id
        return "Enviado para a caixa de rascunhos do app (não publicado)"

    await run.step("Envio para rascunhos", upload)

    async def status():
        for _ in range(20):
            current = await tt.status(tokens, account, holder["id"])
            if current.status in ("SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"):
                return "ok", f"Status {current.status}"
            if current.status == "FAILED":
                raise StepFailed(f"O TikTok recusou: {current.extra.get('fail_reason')}")
            await asyncio.sleep(3)
        return "warning", "O TikTok ainda está processando depois de 60 s"

    await run.step("Status no TikTok", status, critical=False)
    run.skip("Exclusão", tt.delete_note + " O rascunho de teste fica na caixa de entrada do app.")
    await run._save()


async def _instagram(run: Run, scratch: Path) -> None:
    ig = connectors.get("instagram")
    tokens, account = await _connection_steps(run, "instagram")
    video = await run.step("Vídeo de teste", lambda: _test_video(scratch))
    holder: dict[str, Any] = {}

    async def container() -> str:
        holder["id"] = await ig.create_container(tokens, account, _upload_for(video))
        return "Contêiner do Reel criado e vídeo enviado"

    await run.step("Envio do Reel", container)

    async def processing():
        status = await ig.wait_ready(tokens, holder["id"], max_wait=120)
        if status == "FINISHED":
            return "ok", "Reel processado e pronto para publicar"
        if status in ("ERROR", "EXPIRED"):
            raise StepFailed(f"O Instagram recusou o vídeo (status {status})")
        return "warning", "O Instagram ainda está processando depois de 2 min"

    await run.step("Processamento", processing, critical=False)
    run.skip("Publicação", "Não publicamos no teste: o Instagram não tem post privado.")
    run.skip("Exclusão", "O contêiner não publicado expira sozinho em 24 h. " + ig.delete_note)
    await run._save()


async def _payments(run: Run, scratch: Path) -> None:
    from clipo_api.services import asaas

    settings = get_settings()

    async def key() -> Any:
        if asaas.mode() == "simulado":
            return "warning", "Sem ASAAS_API_KEY: cobrança em modo simulado (só desenvolvimento)"
        if asaas.mode() == "off":
            raise StepFailed("ASAAS_API_KEY não está configurada no .env.")
        return f"Chave configurada ({settings.asaas_environment})"

    await run.step("Chave do Asaas", key)

    async def account() -> str:
        try:
            data = await asaas.balance()
        except asaas.AsaasError as exc:
            raise StepFailed(exc.message) from exc
        return f"API respondeu (saldo R$ {float(data.get('balance') or 0):.2f})"

    await run.step("Conexão com a API", account)
    token = settings.asaas_webhook_token
    await run.step(
        "Token do webhook",
        lambda: _ok("Configurado") if token else _fail("ASAAS_WEBHOOK_TOKEN não está configurado no .env."),
    )
    body = json.dumps({"event": "CLIPO_DIAGNOSTIC", "id": f"diag-{run.doc['_id']}"}).encode()
    request_id = f"diag-{run.doc['_id'][:24]}"

    async def post(given: str, rid: str) -> httpx.Response:
        async with httpx.AsyncClient(
            base_url=settings.api_internal_url, transport=API_TRANSPORT, timeout=20
        ) as http:
            return await http.post(
                "/api/v1/webhooks/asaas",
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "asaas-access-token": given,
                    "X-Request-ID": rid,
                },
            )

    async def signed() -> str:
        resp = await post(token, request_id)
        if resp.status_code != 200:
            raise StepFailed(f"O webhook respondeu HTTP {resp.status_code} a um evento com o token certo")
        return "Evento com o token certo aceito"

    await run.step("Evento com token", signed)

    async def forged() -> str:
        resp = await post("token-falso", f"{request_id}-x")
        if resp.status_code != 401:
            raise StepFailed(f"Um evento com token falso foi aceito (HTTP {resp.status_code})")
        return "Token falso recusado"

    await run.step("Token falso é recusado", forged)

    async def logged() -> str:
        found = await run.db.system_logs.find_one({"request_id": request_id, "event": "asaas.received"})
        if not found:
            raise StepFailed("O evento não apareceu no log do sistema")
        return "Evento registrado no log do sistema"

    await run.step("Registro no log", logged, critical=False)


async def _ok(message: str) -> str:
    return message


RUNNERS: dict[str, tuple[int, Callable[[Run, Path], Awaitable[None]]]] = {
    "youtube": (7, _youtube),
    "tiktok": (8, _tiktok),
    "instagram": (8, _instagram),
    "payments": (6, _payments),
}


async def start(db: AsyncDatabase, user_id: str, target: str) -> tuple[dict[str, Any], dict[str, Any]]:
    now = datetime.now(UTC)
    diagnostic = {
        "_id": uuid4().hex,
        "user_id": user_id,
        "target": target,
        "status": "queued",
        "steps": [],
        "created_at": now,
        "finished_at": None,
    }
    job = await jobs.enqueue(
        db, "diagnostic.run", user_id, {"diagnostic_id": diagnostic["_id"]}, max_attempts=1
    )
    diagnostic["job_id"] = job["_id"]
    await db.diagnostics.insert_one(diagnostic)
    return diagnostic, job


async def run_diagnostic(ctx) -> dict[str, Any]:
    """Handler do worker para o job diagnostic.run."""
    db = ctx.db
    diagnostic = await db.diagnostics.find_one({"_id": ctx.job["payload"]["diagnostic_id"]})
    total, runner = RUNNERS[diagnostic["target"]]
    run = Run(db, diagnostic, ctx.id, total)
    await db.diagnostics.update_one({"_id": diagnostic["_id"]}, {"$set": {"status": "running"}})
    try:
        await runner(run, ctx.scratch)
    except StepFailed:
        pass
    statuses = {s["status"] for s in run.steps}
    final = "failed" if "failed" in statuses else "warning" if "warning" in statuses else "passed"
    await db.diagnostics.update_one(
        {"_id": diagnostic["_id"]},
        {"$set": {"status": final, "steps": run.steps, "finished_at": datetime.now(UTC)}},
    )
    await record(
        "integration",
        "diagnostic.finished",
        f"Diagnóstico de {diagnostic['target']}: {final}",
        level="error" if final == "failed" else "warning" if final == "warning" else "info",
        outcome="failure" if final == "failed" else "success",
        user_id=diagnostic["user_id"],
        platform=diagnostic["target"],
        details={"diagnostic_id": diagnostic["_id"], "steps": len(run.steps)},
    )
    return {"diagnostic_id": diagnostic["_id"], "status": final}


def public_diagnostic(d: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": d["_id"],
        "target": d["target"],
        "status": d["status"],
        "steps": d.get("steps", []),
        "job_id": d.get("job_id"),
        "created_at": d["created_at"].isoformat(),
        "finished_at": d["finished_at"].isoformat() if d.get("finished_at") else None,
    }

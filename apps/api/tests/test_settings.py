"""Preferências com efeito real, webhooks de saída assinados, pausa da fila e checagens da conta."""

import hashlib
import hmac
import json
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from conftest import csrf_headers, make_user

from clipo_api import worker
from clipo_api.core.config import get_settings
from clipo_api.services import jobs, publications, settings, subtitles


def h(client) -> dict:
    return csrf_headers(client)


def db(client):
    return client.app.state.mongo[get_settings().mongodb_db]


def me(client) -> str:
    return client.get("/api/me").json()["user"]["id"]


def insert_pub(client, user_id: str, *, status: str = "scheduled", minutes: int = -1) -> str:
    pub_id = uuid4().hex
    now = datetime.now(UTC)
    target = publications.new_target("youtube", "Corte", "", [], None)
    client.portal.call(
        db(client).publications.insert_one,
        {
            "_id": pub_id,
            "user_id": user_id,
            "source": {"kind": "clip", "id": "c1"},
            "title": "Corte",
            "status": status,
            "timezone": "America/Sao_Paulo",
            "scheduled_at": now + timedelta(minutes=minutes),
            "targets": [target],
            "job_id": f"pub-{pub_id}",
            "attempts": 0,
            "created_at": now,
            "updated_at": now,
            "published_at": None,
        },
    )
    return pub_id


def status_of(client, pub_id: str) -> str:
    return client.get(f"/api/v1/publications/{pub_id}").json()["publication"]["status"]


def test_automacao_pausada_segura_a_fila_ate_religar(client, outbox):
    make_user(client, outbox)
    pub_id = insert_pub(client, me(client))
    resp = client.patch(
        "/api/v1/settings/workspace", json={"automation": {"enabled": False}}, headers=h(client)
    )
    assert resp.json()["workspace"]["automation"]["enabled"] is False
    assert client.portal.call(publications.schedule_due, db(client)) == 0
    assert status_of(client, pub_id) == "scheduled"

    client.patch("/api/v1/settings/workspace", json={"automation": {"enabled": True}}, headers=h(client))
    assert client.portal.call(publications.schedule_due, db(client)) == 1
    assert status_of(client, pub_id) == "publishing"


def test_pausar_tira_da_fila_e_retomar_confere_a_rede(client, outbox):
    make_user(client, outbox)
    pub_id = insert_pub(client, me(client))
    assert (
        client.post(f"/api/v1/publications/{pub_id}/pause", headers=h(client)).json()["publication"]["status"]
        == "paused"
    )
    assert client.portal.call(publications.schedule_due, db(client)) == 0
    assert client.post(f"/api/v1/publications/{pub_id}/pause", headers=h(client)).status_code == 409
    # Retomar valida de novo: o corte de teste não existe, então não volta para a fila.
    assert client.post(f"/api/v1/publications/{pub_id}/resume", headers=h(client)).status_code in (409, 422)
    assert status_of(client, pub_id) == "paused"
    listed = client.get("/api/v1/publications", params={"status": "paused"}).json()["items"]
    assert [p["id"] for p in listed] == [pub_id] and listed[0]["thumbnail_url"] is None


def test_preferencias_padrao_parcial_e_lixeira_com_prazo_do_workspace(client, outbox):
    make_user(client, outbox)
    data = client.get("/api/v1/settings").json()
    assert data["workspace"]["privacy"]["trash_days"] == 7 and data["me"]["strict_ip"] is False
    resp = client.patch(
        "/api/v1/settings/workspace",
        json={"privacy": {"trash_days": 30}, "render": {"watermark": {"enabled": True, "text": "@ana"}}},
        headers=h(client),
    )
    ws = resp.json()["workspace"]
    assert ws["render"]["watermark"] == {
        "enabled": True,
        "text": "@ana",
        "opacity": 35,
        "position": "top-right",
    }
    assert (
        client.patch(
            "/api/v1/settings/workspace", json={"privacy": {"trash_days": 9}}, headers=h(client)
        ).status_code
        == 422
    )

    vid = uuid4().hex
    now = datetime.now(UTC)
    client.portal.call(
        db(client).videos.insert_one,
        {
            "_id": vid,
            "user_id": me(client),
            "title": "v",
            "status": "ready",
            "deleted_at": None,
            "created_at": now,
            "updated_at": now,
            "tags": [],
        },
    )
    assert "30 dias" in client.delete(f"/api/v1/videos/{vid}", headers=h(client)).json()["message"]

    mine = client.patch(
        "/api/v1/settings/me", json={"glow": "high", "strict_ip": True}, headers=h(client)
    ).json()["me"]
    assert mine["glow"] == "high" and mine["strict_ip"] is True and mine["waveform"] is True


def test_ip_estrito_derruba_sessao_de_outra_rede(client, outbox):
    make_user(client, outbox)
    client.patch("/api/v1/settings/me", json={"strict_ip": True}, headers=h(client))
    # A sessão foi aberta pelo "testclient"; a renovação vem de outro IP.
    client.portal.call(db(client).sessions.update_many, {}, {"$set": {"ip": "203.0.113.9"}})
    resp = client.post("/api/auth/refresh", headers=h(client))
    assert resp.status_code == 401 and resp.json()["error"]["code"] == "ip_changed"


class _Hook(BaseHTTPRequestHandler):
    received: list = []

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        _Hook.received.append({"headers": dict(self.headers), "body": body})
        self.send_response(204 if len(_Hook.received) > 1 else 500)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def hook_server():
    _Hook.received = []
    server = HTTPServer(("127.0.0.1", 0), _Hook)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/clipo"
    server.shutdown()


def drain(client, tmp_path: Path) -> list[str]:
    async def run() -> list[str]:
        out = []
        while job := await jobs.claim(db(client), "w"):
            out.append(await worker.run_job(db(client), job, "w", tmp_path))
        return out

    return client.portal.call(run)


def test_webhook_assinado_tenta_de_novo_e_registra_entregas(client, outbox, hook_server, tmp_path):
    make_user(client, outbox)
    # Pessoa comum não vê webhooks: são do painel do administrador.
    assert client.get("/api/v1/webhooks").status_code == 403
    client.portal.call(db(client).users.update_many, {}, {"$set": {"role": "super_admin"}})
    client.post("/api/auth/login", json={"email": "ana@example.com", "password": "senha-forte-123"})
    created = client.post(
        "/api/v1/webhooks",
        json={"name": "n8n", "url": hook_server, "events": ["publication.published"]},
        headers=h(client),
    ).json()
    secret, hook = created["secret"], created["webhook"]
    assert secret.startswith("whsec_") and "secret" not in hook

    client.post(f"/api/v1/webhooks/{hook['id']}/test", headers=h(client))
    assert drain(client, tmp_path) == ["queued"]  # 500 na primeira: volta para a fila
    client.portal.call(
        db(client).jobs.update_many, {"status": "queued"}, {"$set": {"run_at": datetime.now(UTC)}}
    )
    assert drain(client, tmp_path) == ["done"]

    last = _Hook.received[-1]
    expected = "sha256=" + hmac.new(secret.encode(), last["body"], hashlib.sha256).hexdigest()
    assert last["headers"]["X-Clipo-Signature"] == expected
    assert json.loads(last["body"])["event"] == "ping"
    deliveries = client.get(f"/api/v1/webhooks/{hook['id']}/deliveries").json()["items"]
    assert deliveries[0]["status"] == "delivered" and deliveries[0]["attempts"] == 2
    listed = client.get("/api/v1/webhooks").json()["items"][0]
    assert listed["success_rate"] == 50.0 and listed["deliveries"] == 2

    # Pausado não entrega; evento que ele não assina não gera entrega.
    client.patch(f"/api/v1/webhooks/{hook['id']}", json={"active": False}, headers=h(client))
    from clipo_api.services import webhooks

    assert client.portal.call(webhooks.emit, db(client), me(client), "publication.published", {}) == 0


def test_webhook_rejeita_endereco_interno_em_producao(monkeypatch):
    from clipo_api.services import webhooks

    monkeypatch.setenv("ENVIRONMENT", "production")
    get_settings.cache_clear()
    try:
        import asyncio

        with pytest.raises(webhooks.UnsafeUrl):
            asyncio.run(webhooks.check_url("https://127.0.0.1/hook"))
        with pytest.raises(webhooks.UnsafeUrl):
            asyncio.run(webhooks.check_url("http://example.com/hook"))
    finally:
        monkeypatch.setenv("ENVIRONMENT", "test")
        get_settings.cache_clear()


def test_status_do_sistema_atividade_e_checagem(client, outbox):
    make_user(client, outbox)
    status = client.get("/api/v1/system/status").json()
    assert {s["id"] for s in status["services"]} == {"api", "database", "storage", "worker", "ffmpeg"}
    assert status["queue"] == {"queued": 0, "running": 0, "failed_24h": 0}
    check = client.get("/api/v1/account/security-check").json()
    assert check["score"] == 100 and any(c["id"] == "strict_ip" for c in check["checks"])
    assert any(i["event"] == "login.success" for i in client.get("/api/v1/account/activity").json()["items"])
    assert client.post("/api/v1/system/cleanup", headers=h(client)).json()["aborted_uploads"] == 0


def test_filtros_de_legenda_e_fila_da_madrugada():
    assert settings.mask_profanity("Porra!") == "p****!"
    assert settings.mask_profanity("certo,") == "certo,"
    f = subtitles.watermark_filter("@ana's: 100%", 40, "bottom-left")
    assert "text='@anas: 100%'" in f and "expansion=none" in f and "x=w*0.04" in f and "y=h-th-h*0.04" in f
    sp = ZoneInfo("America/Sao_Paulo")
    noon = datetime(2026, 10, 29, 12, 0, tzinfo=sp)
    assert settings.night_run_at(noon) == datetime(2026, 10, 30, 1, 0, tzinfo=sp)
    assert settings.night_run_at(datetime(2026, 10, 29, 0, 30, tzinfo=sp)) == datetime(
        2026, 10, 29, 1, 0, tzinfo=sp
    )
    assert settings.night_run_at(datetime(2026, 10, 29, 3, 0, tzinfo=sp)) is None

"""F1: logs do sistema, mascaramento, consulta pelo admin, cliente HTTP com log e alertas."""

import csv
import io
import json

import httpx
import pytest
from conftest import csrf_headers, make_user

from clipo_api.observability import alerts, logs
from clipo_api.observability.http import LoggedClient
from clipo_api.observability.redact import MASK, redact, redact_text, redact_url

PASSWORD = "senha-forte-123"


def logs_for(client, **query):
    return client.portal.call(
        lambda: client.app.state.db.system_logs.find(query).sort("created_at", 1).to_list()
    )


def make_admin(client, outbox, role="super_admin", email="admin@example.com"):
    make_user(client, outbox, email=email)
    db = client.app.state.db
    client.portal.call(db.users.update_one, {"email": email}, {"$set": {"role": role}})
    client.cookies.clear()
    # O papel entra no token no login.
    assert client.post("/api/auth/login", json={"email": email, "password": PASSWORD}).status_code == 200


# ---------------------------------------------------------------- mascaramento


def test_mascaramento_por_campo_e_por_formato():
    data = redact(
        {
            "password": "x",
            "client_secret": "y",
            "headers": {"Authorization": "Bearer abc.def", "Cookie": "clipo_access=z"},
            "nested": [{"refresh_token": "t"}],
            "texto": "token Bearer abcdef123 e jwt eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
            "cartao": "pagou com 4111 1111 1111 1111",
            "arquivo": "video_1793240039123.mp4",
            "email": "ana.souza@example.com",
        }
    )
    assert data["password"] == data["client_secret"] == MASK
    assert data["headers"] == {"Authorization": MASK, "Cookie": MASK}
    assert data["nested"] == [{"refresh_token": MASK}]
    assert "abcdef123" not in data["texto"] and "eyJ" not in data["texto"]
    assert "4111" not in data["cartao"]
    # Número que não é cartão (timestamp) continua legível.
    assert data["arquivo"] == "video_1793240039123.mp4"
    assert data["email"] == "a***@example.com"


def test_url_assinada_perde_a_assinatura():
    url = redact_url("https://s3.local/b/k.mp4?X-Amz-Signature=abc&X-Amz-Credential=def&parte=2")
    assert "abc" not in url and "def" not in url
    assert "parte=2" in url
    assert redact_text("https://x.com/cb?code=segredo&state=outro").count(MASK) == 2


def test_nenhum_segredo_chega_ao_banco(client, outbox):
    make_user(client, outbox)
    client.post("/api/auth/login", json={"email": "ana@example.com", "password": "senha-errada-1"})
    access = client.cookies.get("clipo_access")
    refresh = client.cookies.get("clipo_refresh")
    db = client.app.state.db
    everything = json.dumps(
        client.portal.call(lambda: db.system_logs.find().to_list())
        + client.portal.call(lambda: db.audit_logs.find().to_list()),
        default=str,
    )
    for secret in (PASSWORD, "senha-errada-1", access, refresh):
        assert secret not in everything
    assert "ana@example.com" not in everything  # e-mail aparece só mascarado


# ---------------------------------------------------------------- eventos de login


def test_login_falha_e_sucesso_com_o_mesmo_id_de_requisicao(client, outbox):
    make_user(client, outbox)
    client.cookies.clear()
    fail = client.post(
        "/api/auth/login",
        json={"email": "ana@example.com", "password": "senha-errada-1"},
        headers={"X-Request-ID": "req-falha-0001"},
    )
    ok = client.post(
        "/api/auth/login",
        json={"email": "ana@example.com", "password": PASSWORD},
        headers={"X-Request-ID": "req-sucesso-0001"},
    )
    assert fail.headers["X-Request-ID"] == "req-falha-0001"
    assert ok.headers["X-Request-ID"] == "req-sucesso-0001"

    [failed] = logs_for(client, request_id="req-falha-0001")
    assert (failed["event"], failed["level"], failed["outcome"]) == ("login.failed", "warning", "failure")
    assert failed["details"]["reason"] == "invalid_credentials"
    [success] = logs_for(client, request_id="req-sucesso-0001")
    assert (success["event"], success["outcome"]) == ("login.success", "success")
    assert success["user_id"] == ok.json()["user"]["id"]


def test_bloqueio_por_tentativas_entra_no_log_uma_vez(client, outbox):
    for _ in range(8):
        client.post("/api/auth/login", json={"email": "alvo@example.com", "password": "tentativa-123"})
    blocked = logs_for(client, event="rate_limited")
    assert len(blocked) == 1
    assert blocked[0]["category"] == "auth"
    assert blocked[0]["details"]["identity"] == "a***@example.com"


def test_id_de_requisicao_inseguro_e_trocado(client):
    resp = client.get("/api/health", headers={"X-Request-ID": "x\r\nSet-Cookie: a=b"})
    assert "\n" not in resp.headers["X-Request-ID"]
    assert len(resp.headers["X-Request-ID"]) == 32


# ---------------------------------------------------------------- consulta pelo admin


def test_usuario_comum_nao_le_logs(client, outbox):
    make_user(client, outbox)
    assert client.get("/api/v1/admin/logs").status_code == 403
    assert client.get("/api/v1/admin/audit").status_code == 403


def test_suporte_le_logs_mas_nao_auditoria(client, outbox):
    make_admin(client, outbox, role="support", email="suporte@example.com")
    assert client.get("/api/v1/admin/logs").status_code == 200
    assert client.get("/api/v1/admin/audit").status_code == 403


def test_admin_filtra_pagina_e_exporta(client, outbox):
    make_admin(client, outbox)
    client.cookies.clear()
    # E-mails diferentes: o limite de 5 tentativas por e-mail não entra no caminho do teste.
    for i in range(3):
        client.post("/api/auth/login", json={"email": f"ninguem{i}@example.com", "password": "errada-0000"})
    client.post("/api/auth/login", json={"email": "admin@example.com", "password": PASSWORD})

    page1 = client.get(
        "/api/v1/admin/logs", params={"category": "auth", "event": "login.failed", "limit": 2}
    ).json()
    assert len(page1["items"]) == 2
    assert all(i["event"] == "login.failed" for i in page1["items"])
    assert page1["next_cursor"]
    page2 = client.get(
        "/api/v1/admin/logs", params={"event": "login.failed", "limit": 2, "cursor": page1["next_cursor"]}
    ).json()
    ids = {i["id"] for i in page1["items"]} | {i["id"] for i in page2["items"]}
    assert len(ids) == 3  # sem repetir nem pular

    warnings = client.get("/api/v1/admin/logs", params={"level": "warning", "q": "senha incorreta"}).json()
    assert warnings["items"] and all(i["level"] == "warning" for i in warnings["items"])

    summary = client.get("/api/v1/admin/logs/summary", params={"category": "auth"}).json()
    assert summary["by_category"]["auth"]["warning"] >= 3

    export = client.get("/api/v1/admin/logs/export.csv", params={"category": "auth"})
    assert export.status_code == 200
    assert export.headers["content-type"].startswith("text/csv")
    rows = list(csv.DictReader(io.StringIO(export.text)))
    assert rows and {"created_at", "event", "message", "request_id"} <= set(rows[0])

    # Exportar logs fica na auditoria.
    audit = client.get("/api/v1/admin/audit", params={"action": "logs.exported"}).json()
    assert len(audit["items"]) == 1


def test_cursor_invalido(client, outbox):
    make_admin(client, outbox)
    assert client.get("/api/v1/admin/logs", params={"cursor": "nao-e-cursor"}).status_code == 400


def test_troca_de_senha_vai_para_a_auditoria(client, outbox):
    make_user(client, outbox)
    client.post(
        "/api/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "nova-senha-456"},
        headers=csrf_headers(client),
    )
    db = client.app.state.db
    actions = [a["action"] for a in client.portal.call(lambda: db.audit_logs.find().to_list())]
    assert "password.changed" in actions


# ---------------------------------------------------------------- cliente HTTP e alertas


def test_cliente_http_registra_chamada_sem_segredos(client):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "provedor fora do ar", "access_token": "vazou"})

    async def call():
        async with LoggedClient(platform="youtube", transport=httpx.MockTransport(handler)) as http:
            await http.get("https://www.googleapis.com/youtube/v3/channels?mine=true&access_token=segredo")

    client.portal.call(call)
    [entry] = logs_for(client, event="http.request", platform="youtube")
    assert entry["level"] == "error"
    assert entry["details"]["status"] == 500
    assert "segredo" not in entry["details"]["url"]
    assert "provedor fora do ar" in entry["details"]["response"]


@pytest.fixture
def sent_alerts(monkeypatch):
    sent = []

    async def fake_send(to, subject, text, html):
        sent.append({"to": to, "subject": subject})

    monkeypatch.setattr(alerts, "send_email", fake_send)
    return sent


def test_falhas_em_sequencia_avisam_o_admin_uma_vez(client, outbox, sent_alerts):
    make_admin(client, outbox)

    async def fail(n):
        for _ in range(n):
            await logs.record(
                "integration", "publish.failed", "TikTok fora do ar", level="error", platform="tiktok"
            )

    client.portal.call(fail, 4)
    assert sent_alerts == []
    client.portal.call(fail, 1)
    assert len(sent_alerts) == 1
    assert sent_alerts[0]["to"] == "admin@example.com"
    assert "tiktok" in sent_alerts[0]["subject"]
    client.portal.call(fail, 3)
    assert len(sent_alerts) == 1  # período de silêncio

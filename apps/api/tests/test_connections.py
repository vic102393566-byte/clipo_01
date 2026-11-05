"""F4: redes simuladas (YouTube, Instagram, TikTok), renovação de token, botão de testes e webhooks."""

import hashlib
import hmac
import json
import shutil
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from conftest import allow_social_accounts, csrf_headers, make_user

from clipo_api import worker
from clipo_api.core.config import get_settings
from clipo_api.services import connections, diagnostics, jobs
from clipo_api.services.connectors import base as connectors_base

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="o diagnóstico gera um vídeo com o FFmpeg"
)


class FakeNetworks:
    """Responde como as APIs do Google/YouTube, do TikTok e da Meta."""

    def __init__(self):
        self.calls: Counter = Counter()
        self.refresh_fails = False
        self.yt_received = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        host, path = url.host, url.path
        form = (
            {k: v[0] for k, v in parse_qs(request.content.decode(errors="ignore")).items()}
            if request.content
            else {}
        )
        key = f"{request.method} {host}{path}"
        self.calls[key] += 1

        # ---------------- Google / YouTube
        if host == "oauth2.googleapis.com" and path == "/token":
            if form.get("grant_type") == "refresh_token":
                if self.refresh_fails:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": "yt-access-novo", "expires_in": 3600})
            return httpx.Response(
                200,
                json={
                    "access_token": "yt-access",
                    "refresh_token": "yt-refresh",
                    "expires_in": 3600,
                    "scope": "youtube",
                },
            )
        if host == "oauth2.googleapis.com" and path == "/revoke":
            return httpx.Response(200)
        if host == "www.googleapis.com" and path == "/youtube/v3/channels":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "UC123",
                            "snippet": {"title": "Canal Teste", "customUrl": "@canalteste"},
                            "statistics": {"subscriberCount": "42"},
                        }
                    ]
                },
            )
        if host == "www.googleapis.com" and path == "/upload/youtube/v3/videos":
            assert json.loads(request.content)["status"]["privacyStatus"] == "private"
            return httpx.Response(200, headers={"Location": "https://www.googleapis.com/upload/sessao-1"})
        if host == "www.googleapis.com" and path == "/upload/sessao-1":
            total = int(request.headers["Content-Range"].split("/")[1])
            self.yt_received += len(request.content)
            if self.yt_received < total:
                return httpx.Response(308)
            return httpx.Response(200, json={"id": "vid123", "status": {"uploadStatus": "uploaded"}})
        if host == "www.googleapis.com" and path == "/youtube/v3/videos":
            if request.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(
                200, json={"items": [{"status": {"uploadStatus": "processed", "privacyStatus": "private"}}]}
            )

        # ---------------- TikTok
        if host == "open.tiktokapis.com":
            if path == "/v2/oauth/token/":
                return httpx.Response(
                    200,
                    json={
                        "access_token": "tt-access",
                        "refresh_token": "tt-refresh",
                        "expires_in": 86400,
                        "refresh_expires_in": 31536000,
                        "open_id": "tt-open-id",
                        "scope": "video.upload",
                    },
                )
            if path == "/v2/user/info/":
                return httpx.Response(
                    200,
                    json={
                        "data": {
                            "user": {
                                "open_id": "tt-open-id",
                                "display_name": "Criador",
                                "username": "criador",
                            }
                        },
                        "error": {"code": "ok"},
                    },
                )
            if path == "/v2/post/publish/creator_info/query/":
                return httpx.Response(
                    200,
                    json={
                        "data": {"privacy_level_options": ["SELF_ONLY"], "max_video_post_duration_sec": 600},
                        "error": {"code": "ok"},
                    },
                )
            if path == "/v2/post/publish/inbox/video/init/":
                return httpx.Response(
                    200,
                    json={
                        "data": {
                            "publish_id": "pub-1",
                            "upload_url": "https://open-upload.tiktokapis.com/up/1",
                        },
                        "error": {"code": "ok"},
                    },
                )
            if path == "/v2/post/publish/status/fetch/":
                return httpx.Response(
                    200, json={"data": {"status": "SEND_TO_USER_INBOX"}, "error": {"code": "ok"}}
                )
            if path == "/v2/oauth/revoke/":
                return httpx.Response(200, json={})
        if host == "open-upload.tiktokapis.com":
            return httpx.Response(201)

        # ---------------- Meta / Instagram
        if host == "graph.facebook.com":
            if path.endswith("/oauth/access_token"):
                long = url.params.get("grant_type") == "fb_exchange_token"
                return httpx.Response(
                    200,
                    json={
                        "access_token": "ig-long" if long else "ig-short",
                        "expires_in": 5184000 if long else 3600,
                    },
                )
            if path.endswith("/me/accounts"):
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "name": "Página",
                                "instagram_business_account": {
                                    "id": "ig-1",
                                    "username": "perfil",
                                    "followers_count": 7,
                                },
                            }
                        ]
                    },
                )
            if path.endswith("/ig-1/media"):
                return httpx.Response(200, json={"id": "container-1"})
            if path.endswith("/container-1"):
                return httpx.Response(200, json={"status_code": "FINISHED"})
            if path.endswith("/media_publish"):
                raise AssertionError("o diagnóstico não pode publicar no Instagram")
        if host == "rupload.facebook.com":
            return httpx.Response(200, json={"success": True})

        raise AssertionError(f"chamada inesperada: {request.method} {url}")


@pytest.fixture
def networks(monkeypatch):
    fake = FakeNetworks()
    for name, value in {
        "YOUTUBE_CLIENT_ID": "yt-id",
        "YOUTUBE_CLIENT_SECRET": "yt-secret",
        "TIKTOK_CLIENT_KEY": "tt-key",
        "TIKTOK_CLIENT_SECRET": "tt-secret",
        "INSTAGRAM_CLIENT_ID": "ig-id",
        "INSTAGRAM_CLIENT_SECRET": "ig-secret",
        "META_WEBHOOK_VERIFY_TOKEN": "verifica-meta",
        "ASAAS_WEBHOOK_TOKEN": "token-do-asaas",
    }.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    monkeypatch.setattr(connectors_base, "HTTP_TRANSPORT", httpx.MockTransport(fake.handler))
    allow_social_accounts(monkeypatch)
    yield fake
    get_settings.cache_clear()


def connect(client, platform: str) -> None:
    start = client.get(f"/api/v1/connections/{platform}/connect", follow_redirects=False)
    assert start.status_code == 303, start.text
    state = parse_qs(urlsplit(start.headers["location"]).query)["state"][0]
    back = client.get(
        f"/api/v1/connections/{platform}/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert back.headers["location"].endswith(f"/contas?connected={platform}"), back.headers["location"]


def drain(client, tmp_path: Path) -> list[str]:
    db = client.app.state.db

    async def run():
        out = []
        while job := await jobs.claim(db, "teste"):
            out.append(await worker.run_job(db, job, "teste", tmp_path))
        return out

    return client.portal.call(run)


def run_diagnostic(client, tmp_path, target: str) -> dict:
    resp = client.post("/api/v1/diagnostics", json={"target": target}, headers=csrf_headers(client))
    assert resp.status_code == 202, resp.text
    drain(client, tmp_path)
    return client.get(f"/api/v1/diagnostics/{resp.json()['diagnostic']['id']}").json()["diagnostic"]


def steps(diag: dict) -> dict[str, str]:
    return {s["name"]: s["status"] for s in diag["steps"]}


def steps_by_name(diag: dict) -> dict[str, str]:
    return {s["name"]: s["message"] for s in diag["steps"]}


def logs(client, **query) -> list[dict]:
    return client.portal.call(lambda: client.app.state.db.system_logs.find(query).to_list())


# ---------------------------------------------------------------- conectar


def test_sem_credenciais_a_rede_aparece_desligada(client, outbox):
    make_user(client, outbox)
    items = {i["platform"]: i for i in client.get("/api/v1/connections").json()["items"]}
    assert set(items) == {"youtube", "instagram", "tiktok"}
    assert items["youtube"]["configured"] is False and items["tiktok"]["supports_delete"] is False
    resp = client.get("/api/v1/connections/youtube/connect", follow_redirects=False)
    assert "connection_error=not_configured" in resp.headers["location"]


def test_conectar_youtube_guarda_token_criptografado(client, outbox, networks):
    make_user(client, outbox)
    start = client.get("/api/v1/connections/youtube/connect", follow_redirects=False)
    params = parse_qs(urlsplit(start.headers["location"]).query)
    assert params["access_type"] == ["offline"] and params["code_challenge_method"] == ["S256"]
    connect(client, "youtube")
    item = next(i for i in client.get("/api/v1/connections").json()["items"] if i["platform"] == "youtube")
    assert item["connected"] and item["status"] == "active"
    assert item["account"]["name"] == "Canal Teste" and item["account"]["followers"] == 42
    raw = client.portal.call(client.app.state.db.connections.find_one, {"platform": "youtube"})
    assert "yt-access" not in json.dumps(raw, default=str) and "yt-refresh" not in json.dumps(
        raw, default=str
    )


def test_retorno_com_state_forjado_e_recusado(client, outbox, networks):
    make_user(client, outbox)
    client.get("/api/v1/connections/tiktok/connect", follow_redirects=False)
    back = client.get(
        "/api/v1/connections/tiktok/callback",
        params={"code": "c", "state": "forjado"},
        follow_redirects=False,
    )
    assert "connection_error=expired" in back.headers["location"]


def test_desconectar_revoga_e_apaga(client, outbox, networks):
    make_user(client, outbox)
    connect(client, "tiktok")
    client.delete("/api/v1/connections/tiktok", headers=csrf_headers(client))
    assert networks.calls["POST open.tiktokapis.com/v2/oauth/revoke/"] == 1
    item = next(i for i in client.get("/api/v1/connections").json()["items"] if i["platform"] == "tiktok")
    assert item["connected"] is False


# ---------------------------------------------------------------- renovação de token


def _expire(client, platform: str, minutes: float) -> None:
    client.portal.call(
        client.app.state.db.connections.update_one,
        {"platform": platform},
        {"$set": {"access_expires_at": datetime.now(UTC) + timedelta(minutes=minutes)}},
    )


def test_token_e_renovado_sozinho_antes_de_usar(client, outbox, networks):
    make_user(client, outbox)
    connect(client, "youtube")
    user_id = client.get("/api/me").json()["user"]["id"]
    _expire(client, "youtube", 2)  # vence em 2 min: renova antes de usar
    conn, tokens = client.portal.call(connections.access, client.app.state.db, user_id, "youtube")
    assert tokens["access_token"] == "yt-access-novo" and tokens["refresh_token"] == "yt-refresh"
    assert [log["details"]["reason"] for log in logs(client, event="token.refreshed")] == ["antes de usar"]


def test_manutencao_renova_o_que_vence_em_24h(client, outbox, networks):
    make_user(client, outbox)
    connect(client, "youtube")
    connect(client, "instagram")
    _expire(client, "youtube", 60 * 10)
    _expire(client, "instagram", 60 * 24 * 30)  # vence em 30 dias: ainda não
    assert client.portal.call(connections.refresh_expiring, client.app.state.db) == 1
    assert [log["platform"] for log in logs(client, event="token.refreshed")] == ["youtube"]


def test_acesso_revogado_pede_para_reconectar(client, outbox, networks):
    make_user(client, outbox)
    connect(client, "youtube")
    networks.refresh_fails = True
    client.post("/api/v1/connections/youtube/refresh", headers=csrf_headers(client))
    item = next(i for i in client.get("/api/v1/connections").json()["items"] if i["platform"] == "youtube")
    assert item["status"] == "needs_reconnect"
    assert logs(client, event="token.reconnect_required")


# ---------------------------------------------------------------- botão de testes


def test_diagnostico_youtube_envia_privado_confere_e_apaga(client, outbox, networks, tmp_path):
    make_user(client, outbox)
    connect(client, "youtube")
    diag = run_diagnostic(client, tmp_path, "youtube")
    assert diag["status"] == "passed", diag["steps"]
    assert steps(diag) == {
        "Conexão e token": "ok",
        "Conta na rede": "ok",
        "Vídeo de teste": "ok",
        "Envio (privado)": "ok",
        "Processamento": "ok",
        "Exclusão": "ok",
    }
    assert networks.calls["DELETE www.googleapis.com/youtube/v3/videos"] == 1
    assert networks.calls["PUT www.googleapis.com/upload/sessao-1"] >= 1
    # Cada passo e o resultado final ficam no log do sistema, com o id do diagnóstico.
    step_logs = logs(client, event="diagnostic.step", platform="youtube")
    assert len(step_logs) == 6 and all(log["details"]["diagnostic_id"] == diag["id"] for log in step_logs)
    assert logs(client, event="diagnostic.finished", platform="youtube")


def test_diagnostico_tiktok_usa_rascunho_e_avisa_que_nao_apaga(client, outbox, networks, tmp_path):
    make_user(client, outbox)
    connect(client, "tiktok")
    diag = run_diagnostic(client, tmp_path, "tiktok")
    assert diag["status"] == "passed"
    result = steps(diag)
    assert result["Envio para rascunhos"] == "ok" and result["Exclusão"] == "skipped"
    assert networks.calls["POST open.tiktokapis.com/v2/post/publish/video/init/"] == 0  # nada publicado
    assert "não permite apagar" in diag["steps"][-1]["message"]


def test_diagnostico_instagram_nao_publica(client, outbox, networks, tmp_path):
    make_user(client, outbox)
    connect(client, "instagram")
    diag = run_diagnostic(client, tmp_path, "instagram")
    assert diag["status"] == "passed"
    result = steps(diag)
    assert result["Envio do Reel"] == "ok" and result["Processamento"] == "ok"
    assert result["Publicação"] == result["Exclusão"] == "skipped"


def test_diagnostico_de_rede_nao_conectada_falha_no_primeiro_passo(client, outbox, networks, tmp_path):
    make_user(client, outbox)
    diag = run_diagnostic(client, tmp_path, "youtube")
    assert diag["status"] == "failed"
    assert diag["steps"] == [diag["steps"][0]] and diag["steps"][0]["name"] == "Conexão e token"
    assert "não está conectada" in diag["steps"][0]["message"]


def test_diagnostico_do_webhook_de_pagamento(client, outbox, networks, tmp_path, monkeypatch):
    make_user(client, outbox)
    monkeypatch.setattr(diagnostics, "API_TRANSPORT", httpx.ASGITransport(app=client.app))
    diag = run_diagnostic(client, tmp_path, "payments")
    assert diag["status"] == "warning", diag["steps"]
    # Sem chave do Asaas o diagnóstico avisa que está no modo simulado, e o resto passa.
    assert list(steps(diag).values()) == ["warning", "ok", "ok", "ok", "ok", "ok"]
    # O evento de teste não mudou o plano de ninguém.
    assert client.get("/api/me").json()["user"]["plan_id"] == "basico"


def test_diagnostico_de_pagamento_sem_segredo(client, outbox, tmp_path):
    make_user(client, outbox)
    diag = run_diagnostic(client, tmp_path, "payments")
    assert diag["status"] == "failed"
    assert "ASAAS_WEBHOOK_TOKEN" in steps_by_name(diag)["Token do webhook"]


# ---------------------------------------------------------------- webhooks das redes


def _tiktok_signed(body: bytes, secret: str = "tt-secret") -> str:
    ts = int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={ts},s={sig}"


def test_webhook_do_tiktok_assinado_e_sem_repeticao(client, networks):
    body = json.dumps(
        {
            "event": "post.publish.complete",
            "create_time": 1,
            "user_openid": "x",
            "content": json.dumps({"publish_id": "pub-1"}),
        }
    ).encode()
    ok = client.post(
        "/api/v1/webhooks/tiktok", content=body, headers={"TikTok-Signature": _tiktok_signed(body)}
    )
    assert ok.json() == {"received": True}
    again = client.post(
        "/api/v1/webhooks/tiktok", content=body, headers={"TikTok-Signature": _tiktok_signed(body)}
    )
    assert again.json()["duplicate"] is True
    forged = client.post(
        "/api/v1/webhooks/tiktok", content=body, headers={"TikTok-Signature": _tiktok_signed(body, "x")}
    )
    assert forged.status_code == 401
    assert logs(client, event="tiktok.post.publish.complete") and logs(client, event="tiktok.rejected")


def test_webhook_da_meta_verificacao_e_assinatura(client, networks):
    verify = client.get(
        "/api/v1/webhooks/meta",
        params={"hub.mode": "subscribe", "hub.verify_token": "verifica-meta", "hub.challenge": "123"},
    )
    assert verify.text == "123"
    assert (
        client.get(
            "/api/v1/webhooks/meta", params={"hub.mode": "subscribe", "hub.verify_token": "x"}
        ).status_code
        == 403
    )
    body = json.dumps({"entry": [{"id": "ig-1", "time": 1, "changes": [{"field": "comments"}]}]}).encode()
    sig = "sha256=" + hmac.new(b"ig-secret", body, hashlib.sha256).hexdigest()
    assert (
        client.post("/api/v1/webhooks/meta", content=body, headers={"X-Hub-Signature-256": sig}).status_code
        == 200
    )
    assert (
        client.post(
            "/api/v1/webhooks/meta", content=body, headers={"X-Hub-Signature-256": "sha256=0"}
        ).status_code
        == 401
    )
    assert logs(client, event="meta.comments")

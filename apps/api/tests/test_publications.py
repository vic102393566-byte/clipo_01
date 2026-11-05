"""F5: publicações agendadas, agendador, status de volta das redes, avisos e calendário."""

import asyncio
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from conftest import allow_social_accounts, csrf_headers, make_user
from test_connections import FakeNetworks, connect
from test_library import _set_plan, drain, pytestmark, ready_video, video_file  # noqa: F401 — fixture

from clipo_api.core.config import get_settings
from clipo_api.services import notifications, publications
from clipo_api.services.connectors import base as connectors_base

SP = ZoneInfo("America/Sao_Paulo")


class Networks(FakeNetworks):
    """Redes simuladas com publicação de verdade (não só o diagnóstico)."""

    def __init__(self):
        super().__init__()
        self.yt_uploads = 0
        self.yt_status = ["processed"]
        self.yt_fail_start: list[int] = []  # códigos HTTP devolvidos no início do envio, em ordem
        self.yt_drop_last_chunk = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        host, path = request.url.host, request.url.path
        if host == "www.googleapis.com" and path == "/upload/youtube/v3/videos":
            self.calls[f"POST {host}{path}"] += 1
            if self.yt_fail_start:
                return httpx.Response(self.yt_fail_start.pop(0), json={"error": {"message": "indisponível"}})
            self.yt_received = 0
            return httpx.Response(200, headers={"Location": "https://www.googleapis.com/upload/sessao-1"})
        if host == "www.googleapis.com" and path == "/upload/sessao-1":
            total = int(request.headers["Content-Range"].split("/")[1])
            self.yt_received += len(request.content)
            if self.yt_received < total:
                return httpx.Response(308)
            if self.yt_drop_last_chunk:
                raise httpx.ReadTimeout("sem resposta", request=request)
            self.yt_uploads += 1
            return httpx.Response(
                200, json={"id": f"vid{self.yt_uploads}", "status": {"uploadStatus": "uploaded"}}
            )
        if host == "www.googleapis.com" and path == "/youtube/v3/videos" and request.method == "GET":
            state = self.yt_status.pop(0) if len(self.yt_status) > 1 else self.yt_status[0]
            return httpx.Response(
                200, json={"items": [{"status": {"uploadStatus": state, "privacyStatus": "private"}}]}
            )
        if host == "open.tiktokapis.com" and path == "/v2/post/publish/video/init/":
            body = json.loads(request.content)
            assert body["post_info"]["privacy_level"] == "SELF_ONLY"
            return httpx.Response(
                200,
                json={
                    "data": {
                        "publish_id": "pub-direto",
                        "upload_url": "https://open-upload.tiktokapis.com/up/2",
                    },
                    "error": {"code": "ok"},
                },
            )
        if host == "open.tiktokapis.com" and path == "/v2/post/publish/status/fetch/":
            return httpx.Response(
                200, json={"data": {"status": "PROCESSING_UPLOAD"}, "error": {"code": "ok"}}
            )
        return super().handler(request)


@pytest.fixture
def nets(monkeypatch):
    fake = Networks()
    for name, value in {
        "YOUTUBE_CLIENT_ID": "yt-id",
        "YOUTUBE_CLIENT_SECRET": "yt-secret",
        "TIKTOK_CLIENT_KEY": "tt-key",
        "TIKTOK_CLIENT_SECRET": "tt-secret",
        "INSTAGRAM_CLIENT_ID": "ig-id",
        "INSTAGRAM_CLIENT_SECRET": "ig-secret",
    }.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    monkeypatch.setattr(connectors_base, "HTTP_TRANSPORT", httpx.MockTransport(fake.handler))
    allow_social_accounts(monkeypatch)
    yield fake
    get_settings.cache_clear()


@pytest.fixture
def mails(monkeypatch):
    sent: list[dict] = []

    async def capture(to, title, body, url, action_label):
        sent.append({"to": to, "title": title, "body": body, "url": url})

    monkeypatch.setattr(notifications, "send_notification_email", capture)
    return sent


def h(client) -> dict:
    return csrf_headers(client)


def db(client):
    return client.app.state.db


def call(client, fn, *args, **kw):
    return client.portal.call(lambda: fn(*args, **kw))


def setup(client, outbox, video_file, tmp_path, *platforms: str) -> dict:
    make_user(client, outbox)
    for p in platforms:
        connect(client, p)
    return ready_video(client, video_file, tmp_path)


def create(client, video: dict, **body) -> dict:
    payload = {
        "source_kind": "video",
        "source_id": video["id"],
        "targets": [{"platform": "youtube", "privacy": "private"}],
        "action": "schedule",
        **body,
    }
    resp = client.post("/api/v1/publications", json=payload, headers=h(client))
    assert resp.status_code == 201, resp.text
    return resp.json()["publication"]


def get(client, pub_id: str) -> dict:
    return client.get(f"/api/v1/publications/{pub_id}").json()["publication"]


def make_due(client, pub_id: str) -> None:
    """Simula o relógio chegando na hora marcada."""
    call(
        client,
        db(client).publications.update_one,
        {"_id": pub_id},
        {"$set": {"scheduled_at": datetime.now(UTC) - timedelta(seconds=1)}},
    )


def check_now(client, pub_id: str) -> None:
    call(
        client,
        db(client).publications.update_one,
        {"_id": pub_id},
        {"$set": {"targets.$[].next_check_at": datetime.now(UTC) - timedelta(seconds=1)}},
    )


def logs(client, **query) -> list[dict]:
    return call(client, lambda: db(client).system_logs.find(query).to_list())


# ---------------------------------------------------------------- critério de saída


def test_agendada_para_daqui_2_min_sai_sozinha_no_youtube(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    local = (datetime.now(SP) + timedelta(minutes=2)).replace(tzinfo=None, microsecond=0)
    pub = create(
        client,
        video,
        title="Aula de sábado",
        description="Texto do YouTube",
        scheduled_at=local.isoformat(),
        timezone="America/Sao_Paulo",
    )
    assert pub["status"] == "scheduled"
    # Hora local de São Paulo virou UTC certinho.
    assert datetime.fromisoformat(pub["scheduled_at"]) == local.replace(tzinfo=SP).astimezone(UTC)
    assert pub["scheduled_local"].endswith("-03:00")

    # Antes da hora o agendador não faz nada.
    assert call(client, publications.schedule_due, db(client)) == 0
    assert drain(client, tmp_path) == []

    make_due(client, pub["id"])
    assert call(client, publications.schedule_due, db(client)) == 1
    assert drain(client, tmp_path) == ["done"]
    sent = get(client, pub["id"])
    yt = sent["targets"][0]
    assert sent["status"] == "publishing" and yt["status"] == "processing"
    assert yt["remote_id"] == "vid1" and yt["url"] == "https://youtu.be/vid1" and yt["privacy"] == "private"

    # O status volta da rede: processado → publicada.
    check_now(client, pub["id"])
    assert call(client, publications.poll_processing, db(client)) == 1
    done = get(client, pub["id"])
    assert done["status"] == "published" and done["targets"][0]["status"] == "published"
    assert nets.yt_uploads == 1

    # Aviso no sino e por e-mail.
    bell = client.get("/api/v1/notifications").json()
    assert bell["unread"] == 1 and bell["items"][0]["kind"] == "publish_success"
    assert bell["items"][0]["link"] == f"/publicacoes/{pub['id']}"
    assert mails and mails[-1]["title"].startswith("“Aula de sábado” foi publicado")

    # E tudo no log.
    events = {e["event"] for e in logs(client, category="publication")}
    assert {
        "publication.scheduled",
        "publication.due",
        "target.uploaded",
        "target.published",
        "publication.published",
    } <= events


# ---------------------------------------------------------------- nunca duas vezes


def test_dois_workers_ao_mesmo_tempo_nao_publicam_duas_vezes(
    client, outbox, video_file, tmp_path, nets, mails
):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    pub = create(client, video, scheduled_at=(datetime.now(UTC) + timedelta(minutes=5)).isoformat())
    make_due(client, pub["id"])

    async def both():
        return await asyncio.gather(*(publications.schedule_due(db(client)) for _ in range(4)))

    assert sum(client.portal.call(both)) == 1
    assert call(client, db(client).jobs.count_documents, {"type": "publication.publish"}) == 1
    assert drain(client, tmp_path) == ["done"]
    # Rodar o agendador de novo não envia outra vez.
    assert call(client, publications.schedule_due, db(client)) == 0
    assert drain(client, tmp_path) == []
    assert nets.yt_uploads == 1


def test_falha_temporaria_tenta_de_novo_e_envia_uma_vez(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    nets.yt_fail_start = [503]
    pub = create(client, video, action="now")
    assert pub["status"] == "publishing"
    assert drain(client, tmp_path) == ["queued"]
    waiting = get(client, pub["id"])["targets"][0]
    assert waiting["status"] == "pending" and "indisponível" in waiting["error"]
    # Libera a espera crescente e roda de novo.
    call(client, db(client).jobs.update_many, {}, {"$set": {"run_at": datetime.now(UTC)}})
    assert drain(client, tmp_path) == ["done"]
    assert get(client, pub["id"])["targets"][0]["status"] == "processing"
    assert nets.yt_uploads == 1
    assert logs(client, event="target.retry")


def test_tres_falhas_desiste_e_avisa(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    nets.yt_fail_start = [503, 503, 503]
    pub = create(client, video, action="now")
    outcomes = []
    for _ in range(3):
        call(client, db(client).jobs.update_many, {}, {"$set": {"run_at": datetime.now(UTC)}})
        outcomes += drain(client, tmp_path)
    assert outcomes == ["queued", "queued", "failed"]
    failed = get(client, pub["id"])
    assert failed["status"] == "failed" and failed["targets"][0]["status"] == "failed"
    bell = client.get("/api/v1/notifications").json()["items"]
    assert bell[0]["kind"] == "publish_failure" and "YouTube" in bell[0]["body"]
    assert logs(client, event="publication.failed")


def test_resultado_incerto_nao_reenvia_sem_confirmacao(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    nets.yt_drop_last_chunk = True
    pub = create(client, video, action="now")
    assert drain(client, tmp_path) == ["done"]
    failed = get(client, pub["id"])
    assert failed["status"] == "failed" and failed["targets"][0]["error_code"] == "uncertain"

    resp = client.post(f"/api/v1/publications/{pub['id']}/retry", headers=h(client))
    assert resp.status_code == 409 and resp.json()["error"]["code"] == "confirm_uncertain"

    nets.yt_drop_last_chunk = False
    resp = client.post(
        f"/api/v1/publications/{pub['id']}/retry", params={"confirm_uncertain": "true"}, headers=h(client)
    )
    assert resp.status_code == 200 and resp.json()["publication"]["status"] == "publishing"
    assert drain(client, tmp_path) == ["done"]
    assert get(client, pub["id"])["targets"][0]["status"] == "processing"


def test_worker_que_cai_no_meio_do_envio_nao_reenvia(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    pub = create(client, video, action="now")
    # Como se o worker tivesse marcado "enviando" e morrido antes da resposta.
    call(
        client,
        db(client).publications.update_one,
        {"_id": pub["id"]},
        {"$set": {"targets.0.status": "uploading"}},
    )
    assert drain(client, tmp_path) == ["done"]
    after = get(client, pub["id"])
    assert after["targets"][0]["error_code"] == "uncertain" and nets.yt_uploads == 0
    assert logs(client, event="target.uncertain")


# ---------------------------------------------------------------- status de volta e webhooks


def test_tiktok_status_volta_pelo_webhook(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "tiktok")
    pub = create(
        client,
        video,
        action="now",
        description="Legenda do TikTok #clipo",
        targets=[{"platform": "tiktok"}],
    )
    # O vídeo de teste tem 30 s: dentro do limite do TikTok.
    assert drain(client, tmp_path) == ["done"]
    tt = get(client, pub["id"])["targets"][0]
    assert tt["status"] == "processing" and tt["remote_id"] == "pub-direto"

    body = json.dumps(
        {
            "event": "post.publish.complete",
            "user_openid": "tt-open-id",
            "create_time": int(time.time()),
            "content": json.dumps({"publish_id": "pub-direto"}),
        }
    ).encode()
    ts = int(time.time())
    sig = hmac.new(b"tt-secret", f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    resp = client.post(
        "/api/v1/webhooks/tiktok",
        content=body,
        headers={"TikTok-Signature": f"t={ts},s={sig}", "Content-Type": "application/json"},
    )
    assert resp.status_code == 200
    done = get(client, pub["id"])
    assert done["status"] == "published" and done["targets"][0]["status"] == "published"
    assert logs(client, event="target.published", platform="tiktok")[0]["details"]["via"] == "webhook"


def test_varias_redes_uma_falha_fica_parcial(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube", "tiktok")
    nets.yt_status = ["rejected"]
    pub = create(
        client,
        video,
        action="now",
        targets=[{"platform": "youtube", "title": "Só no YouTube"}, {"platform": "tiktok"}],
    )
    assert pub["targets"][0]["title"] == "Só no YouTube"
    assert drain(client, tmp_path) == ["done"]
    check_now(client, pub["id"])
    call(client, publications.poll_processing, db(client))
    assert call(client, publications.tiktok_event, db(client), "post.publish.complete", "pub-direto", None)
    final = get(client, pub["id"])
    assert final["status"] == "partial"
    states = {t["platform"]: t["status"] for t in final["targets"]}
    assert states == {"youtube": "failed", "tiktok": "published"}
    kinds = {n["kind"] for n in client.get("/api/v1/notifications").json()["items"]}
    assert kinds == {"publish_success", "publish_failure"}


def test_token_revogado_pede_reconexao_e_avisa(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    nets.yt_fail_start = [401]
    pub = create(client, video, action="now")
    assert drain(client, tmp_path) == ["done"]
    after = get(client, pub["id"])
    assert after["status"] == "failed" and after["targets"][0]["error_code"] == "reconnect_required"
    yt = next(i for i in client.get("/api/v1/connections").json()["items"] if i["platform"] == "youtube")
    assert yt["status"] == "needs_reconnect"
    kinds = [n["kind"] for n in client.get("/api/v1/notifications").json()["items"]]
    assert "reconnect_required" in kinds
    assert any(m["title"] == "Conecte o YouTube de novo" for m in mails)
    # Agendar para essa rede fica bloqueado até reconectar.
    resp = client.post(
        "/api/v1/publications",
        json={
            "source_kind": "video",
            "source_id": video["id"],
            "targets": [{"platform": "youtube"}],
            "scheduled_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        },
        headers=h(client),
    )
    assert resp.json()["error"]["code"] == "reconnect_required"


# ---------------------------------------------------------------- validações e calendário


def test_validacoes_antes_de_agendar(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    base = {"source_kind": "video", "source_id": video["id"], "targets": [{"platform": "youtube"}]}
    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()

    def err(**body):
        resp = client.post("/api/v1/publications", json={**base, **body}, headers=h(client))
        assert resp.status_code == 422, resp.text
        return resp.json()["error"]["code"]

    assert err(scheduled_at=(datetime.now(UTC) - timedelta(hours=1)).isoformat()) == "in_the_past"
    assert err(scheduled_at=(datetime.now(UTC) + timedelta(days=400)).isoformat()) == "too_far"
    assert err(scheduled_at=future, timezone="Lua/Base") == "validation_error"
    assert err(scheduled_at=future, targets=[{"platform": "youtube", "title": "x" * 101}]) == "title_too_long"
    assert (
        err(scheduled_at=future, targets=[{"platform": "youtube", "privacy": "PUBLIC"}]) == "invalid_privacy"
    )
    assert err(scheduled_at=future, targets=[{"platform": "tiktok"}]) == "not_connected"
    assert err(action="schedule") == "validation_error"  # sem data
    assert (
        err(scheduled_at=future, targets=[{"platform": "youtube"}, {"platform": "youtube"}])
        == "validation_error"
    )
    # Rascunho não exige rede conectada.
    draft = create(client, video, action="draft", targets=[{"platform": "tiktok"}])
    assert draft["status"] == "draft"
    # Mas agendar o rascunho exige.
    resp = client.post(
        f"/api/v1/publications/{draft['id']}/schedule", json={"scheduled_at": future}, headers=h(client)
    )
    assert resp.json()["error"]["code"] == "not_connected"


def test_duracao_fora_do_limite_da_rede(client, outbox, video_file, tmp_path, nets, mails, monkeypatch):
    video = setup(client, outbox, video_file, tmp_path, "tiktok")
    monkeypatch.setitem(publications.RULES["tiktok"], "max_s", 10)
    resp = client.post(
        "/api/v1/publications",
        json={
            "source_kind": "video",
            "source_id": video["id"],
            "targets": [{"platform": "tiktok"}],
            "action": "now",
        },
        headers=h(client),
    )
    assert resp.json()["error"]["code"] == "duration_not_allowed"


def test_calendario_reagendar_desagendar_cancelar(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    day = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0) + timedelta(days=2)
    a = create(client, video, scheduled_at=day.isoformat())
    b = create(client, video, scheduled_at=(day + timedelta(days=10)).isoformat())

    def window(start, end):
        resp = client.get("/api/v1/publications", params={"from": start.isoformat(), "to": end.isoformat()})
        assert resp.status_code == 200, resp.text
        return [p["id"] for p in resp.json()["items"]]

    assert window(day - timedelta(days=1), day + timedelta(days=1)) == [a["id"]]
    assert window(day - timedelta(days=1), day + timedelta(days=30)) == [a["id"], b["id"]]
    too_long = client.get(
        "/api/v1/publications",
        params={"from": day.isoformat(), "to": (day + timedelta(days=100)).isoformat()},
    )
    assert too_long.json()["error"]["code"] == "range_too_long"

    # Arrastar no calendário: reagenda.
    moved = client.patch(
        f"/api/v1/publications/{a['id']}",
        json={"scheduled_at": (day + timedelta(days=11)).isoformat()},
        headers=h(client),
    )
    assert moved.status_code == 200, moved.text
    assert window(day - timedelta(days=1), day + timedelta(days=1)) == []
    assert logs(client, event="publication.rescheduled")

    # Editar só o texto de uma rede mantém o resto.
    edited = client.patch(
        f"/api/v1/publications/{a['id']}",
        json={"targets": [{"platform": "youtube", "description": "novo texto"}]},
        headers=h(client),
    ).json()["publication"]
    assert (
        edited["targets"][0]["description"] == "novo texto" and edited["targets"][0]["privacy"] == "private"
    )

    unscheduled = client.post(f"/api/v1/publications/{a['id']}/unschedule", headers=h(client))
    assert unscheduled.json()["publication"]["status"] == "draft"
    cancelled = client.post(f"/api/v1/publications/{b['id']}/cancel", headers=h(client))
    assert cancelled.json()["publication"]["status"] == "cancelled"
    make_due(client, b["id"])
    assert call(client, publications.schedule_due, db(client)) == 0

    drafts = client.get("/api/v1/publications", params={"status": "draft"}).json()["items"]
    assert [p["id"] for p in drafts] == [a["id"]]
    assert client.delete(f"/api/v1/publications/{a['id']}", headers=h(client)).status_code == 200
    assert client.get(f"/api/v1/publications/{a['id']}").status_code == 404


def test_cancelar_enquanto_espera_nova_tentativa(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    nets.yt_fail_start = [503]
    pub = create(client, video, action="now")
    assert drain(client, tmp_path) == ["queued"]
    resp = client.post(f"/api/v1/publications/{pub['id']}/cancel", headers=h(client))
    assert resp.status_code == 200
    assert get(client, pub["id"])["status"] == "failed"
    assert drain(client, tmp_path) == []
    assert nets.yt_uploads == 0


def test_conteudo_agendado_nao_vai_para_a_lixeira(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    pub = create(client, video, scheduled_at=(datetime.now(UTC) + timedelta(hours=1)).isoformat())
    resp = client.delete(f"/api/v1/videos/{video['id']}", headers=h(client))
    assert resp.status_code == 409 and resp.json()["error"]["code"] == "has_scheduled_publications"
    client.post(f"/api/v1/publications/{pub['id']}/cancel", headers=h(client))
    assert client.delete(f"/api/v1/videos/{video['id']}", headers=h(client)).status_code == 200


def test_outro_usuario_nao_ve_publicacoes_nem_avisos(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    pub = create(client, video, action="now")
    drain(client, tmp_path)
    nets.yt_status = ["processed"]
    check_now(client, pub["id"])
    call(client, publications.poll_processing, db(client))
    mine = client.get("/api/v1/notifications").json()["items"][0]["id"]

    client.cookies.clear()
    make_user(client, outbox, email="bia@example.com")
    assert client.get(f"/api/v1/publications/{pub['id']}").status_code == 404
    assert client.get("/api/v1/publications").json()["items"] == []
    assert client.get("/api/v1/notifications").json() == {"items": [], "unread": 0, "next_before": None}
    assert client.post(f"/api/v1/notifications/{mine}/read", headers=h(client)).status_code == 404
    resp = client.post(
        "/api/v1/publications",
        json={
            "source_kind": "video",
            "source_id": video["id"],
            "targets": [{"platform": "youtube"}],
            "action": "now",
        },
        headers=h(client),
    )
    assert resp.json()["error"]["code"] == "source_unavailable"


# ---------------------------------------------------------------- avisos


def test_sino_ler_e_ler_todos_e_preferencia_de_email(client, outbox, video_file, tmp_path, nets, mails):
    video = setup(client, outbox, video_file, tmp_path, "youtube")
    # Desliga o e-mail de "publicado": o aviso aparece só no sino.
    resp = client.patch(
        "/api/v1/account", json={"notifications": {"publish_success": False}}, headers=h(client)
    )
    assert resp.status_code == 200, resp.text
    for _ in range(2):
        pub = create(client, video, action="now")
        drain(client, tmp_path)
        nets.yt_status = ["processed"]
        check_now(client, pub["id"])
        call(client, publications.poll_processing, db(client))
    assert mails == []
    bell = client.get("/api/v1/notifications").json()
    assert bell["unread"] == 2
    first = bell["items"][0]["id"]
    assert client.post(f"/api/v1/notifications/{first}/read", headers=h(client)).json() == {"ok": True}
    assert client.get("/api/v1/notifications", params={"unread": "true"}).json()["unread"] == 1
    assert client.post("/api/v1/notifications/read-all", headers=h(client)).json() == {"marked": 1}
    assert client.get("/api/v1/notifications").json()["unread"] == 0


def test_aviso_de_espaco_quase_cheio_uma_vez_por_mes(
    client, outbox, video_file, tmp_path, mails, monkeypatch
):
    make_user(client, outbox)
    _set_plan(monkeypatch, storage_bytes=int(video_file.stat().st_size * 1.05))
    ready_video(client, video_file, tmp_path)
    items = client.get("/api/v1/notifications").json()["items"]
    assert [n["kind"] for n in items] == ["storage_alert"]
    assert "ocupado" in items[0]["title"] and mails[-1]["url"].endswith("/armazenamento")
    # Conferir de novo no mesmo mês não repete o aviso.
    user_id = call(client, db(client).users.find_one, {})["_id"]
    call(client, notifications.storage_check, db(client), user_id)
    assert len(client.get("/api/v1/notifications").json()["items"]) == 1

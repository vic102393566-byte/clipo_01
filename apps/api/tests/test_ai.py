"""F7: gateway de IA (reserva entre provedores, custo), prompts A/B, créditos, transcrição,
metadados da fala, cortes inteligentes e legendas."""

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from conftest import csrf_headers, make_user
from test_library import _set_plan, drain, pytestmark, upload_video, video_file  # noqa: F401 — fixtures

from clipo_api.core.config import get_settings
from clipo_api.services import transcription
from clipo_api.services.ai import config as ai_config
from clipo_api.services.ai import gateway
from clipo_api.services.ai.tasks import Metadata, Suggestion, Suggestions

HAS_LIBASS = (
    " ass " in subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True).stdout
)
PRICES = {"gemini:gemini-flash-latest": {"input_per_mtok": 0.3, "output_per_mtok": 2.5}}


@pytest.fixture(scope="session")
def long_video(tmp_path_factory) -> Path:
    """Vídeo de 20 minutos, pequeno (160x90, 5 fps): o critério de saída fala em 20 min."""
    path = tmp_path_factory.mktemp("ia") / "aula-20min.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=5:duration=1200",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=300:duration=1200",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-b:a",
            "16k",
            "-shortest",
            str(path),
        ],
        check=True,
    )
    return path


def fake_transcript(duration: float) -> dict:
    """Uma frase a cada 10 s, palavras de 0,5 s: como o faster-whisper devolve."""
    segments = []
    t = 0.0
    n = 0
    while t + 8 <= duration:
        words = [
            {"s": round(t + i * 0.5, 2), "e": round(t + i * 0.5 + 0.45, 2), "w": f"palavra{n}_{i}"}
            for i in range(16)
        ]
        words[-1]["w"] += "."
        segments.append({"start": t, "end": t + 8, "text": " ".join(w["w"] for w in words), "words": words})
        t += 10
        n += 1
    return {"language": "pt", "segments": segments}


class FakeLLM:
    """Simula os provedores. `fail`: provedores que dão erro; `bad`: os que respondem fora do formato."""

    def __init__(self):
        self.calls: list[dict] = []
        self.fail: set[str] = set()
        self.bad: set[str] = set()

    async def __call__(self, provider, model, messages, schema, temperature):
        self.calls.append(
            {"provider": provider, "model": model, "human": messages[1][1], "system": messages[0][1]}
        )
        if provider in self.fail:
            raise TimeoutError("o provedor não respondeu")
        if provider in self.bad:
            raise ValueError("resposta fora do formato")
        usage = {"input_tokens": 12000, "output_tokens": 800}
        if schema is Metadata:
            return Metadata(
                title="Como cortar vídeos",
                description="Aprenda já.",
                hashtags=["clipo", "#cortes"],
                call_to_action="Comente!",
            ), usage
        # Sete sugestões: uma fora do vídeo, uma longa demais, uma sobreposta, uma curta, três boas.
        raw = [
            Suggestion(start_s=60.2, end_s=110, title="Abertura forte", hook="h", score=95, reason="gancho"),
            Suggestion(start_s=65, end_s=100, title="Sobreposta", hook="h", score=90, reason="repete"),
            Suggestion(start_s=300, end_s=500, title="Longa", hook="h", score=88, reason="muito longa"),
            Suggestion(start_s=400, end_s=410, title="Curta", hook="h", score=80, reason="curta"),
            Suggestion(start_s=700, end_s=760, title="Meio", hook="h", score=70, reason="história"),
            Suggestion(start_s=1150, end_s=1190, title="Final", hook="h", score=60, reason="fechamento"),
            Suggestion(start_s=5000, end_s=5050, title="Fora", hook="h", score=99, reason="inventada"),
        ]
        return Suggestions(suggestions=raw), usage


@pytest.fixture
def ai(monkeypatch):
    fake = FakeLLM()
    monkeypatch.setenv("GEMINI_API_KEY", "chave-gemini")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "chave-claude")
    monkeypatch.setenv("STT_PROVIDER", "local")
    get_settings.cache_clear()
    ai_config.invalidate()
    monkeypatch.setattr(gateway, "invoke_model", fake)
    monkeypatch.setattr(
        transcription,
        "_local_transcribe",
        lambda path, duration, progress, stop, language=None: fake_transcript(duration),
    )
    yield fake
    get_settings.cache_clear()
    ai_config.invalidate()


def h(client) -> dict:
    return csrf_headers(client)


def db(client):
    return client.app.state.db


def call(client, fn, *args, **kw):
    return client.portal.call(lambda: fn(*args, **kw))


def logs(client, **query) -> list[dict]:
    return call(client, lambda: db(client).system_logs.find(query).to_list())


def become_super_admin(client, outbox, email="root@example.com") -> None:
    make_user(client, outbox, email=email)
    call(client, db(client).users.update_one, {"email": email}, {"$set": {"role": "super_admin"}})
    assert (
        client.post("/api/auth/login", json={"email": email, "password": "senha-forte-123"}).status_code
        == 200
    )


def ready(client, path: Path, tmp_path: Path, title="Aula longa") -> dict:
    video = upload_video(client, path, title)
    assert drain(client, tmp_path) == ["done"]
    return client.get(f"/api/v1/videos/{video['id']}").json()["video"]


def credits_used(client) -> int:
    return client.get("/api/v1/ai/usage").json()["credits"]["used"]


# ---------------------------------------------------------------- critério de saída


def test_video_de_20_min_gera_transcricao_5_cortes_legendas_e_custo_no_log(
    client, outbox, long_video, tmp_path, ai
):
    become_super_admin(client, outbox)
    assert (
        client.put("/api/v1/admin/ai/settings", json={"prices": PRICES}, headers=h(client)).status_code == 200
    )
    video = ready(client, long_video, tmp_path)
    assert round(video["duration_s"]) == 1200

    resp = client.post(f"/api/v1/videos/{video['id']}/highlights", json={"count": 5}, headers=h(client))
    assert resp.status_code == 202, resp.text
    # 5 créditos dos cortes + 20 minutos de transcrição.
    assert credits_used(client) == 25
    assert drain(client, tmp_path) == ["done"]

    transcript = client.get(f"/api/v1/videos/{video['id']}/transcript", params={"words": "true"}).json()[
        "transcript"
    ]
    assert transcript["status"] == "ready" and transcript["word_count"] == 120 * 16
    first_word = transcript["segments"][0]["words"][0]
    assert set(first_word) == {"s", "e", "w"}

    items = client.get(f"/api/v1/videos/{video['id']}/suggestions").json()["items"]
    assert len(items) == 5
    assert [i["score"] for i in items] == sorted((i["score"] for i in items), reverse=True)
    assert all(20 <= i["duration_s"] <= 76.5 and i["reason"] for i in items)
    assert all(i["end_s"] <= 1200 for i in items)
    titles = {i["title"] for i in items}
    assert "Fora" not in titles and "Sobreposta" not in titles  # inventada e sobreposta saem
    first = next(i for i in items if i["title"] == "Abertura forte")
    assert first["start_s"] == 59.9  # encaixado no começo da palavra (60,0) menos 0,1 s

    # Custo de cada chamada no log: transcrição local (US$ 0) e a escolha dos trechos com preço.
    generated = logs(client, event="highlights.generated")
    assert generated and generated[0]["details"]["cost_usd"] == pytest.approx(12000 * 0.3e-6 + 800 * 2.5e-6)
    assert logs(client, event="transcription.generated")[0]["details"]["cost_usd"] == 0.0
    assert "US$" in generated[0]["message"]

    # A sugestão vira corte, e o corte ganha legenda gravada e arquivo de legenda.
    accepted = client.post(f"/api/v1/suggestions/{first['id']}/accept", json={}, headers=h(client))
    assert accepted.status_code == 202, accepted.text
    clip_id = accepted.json()["clip"]["id"]
    assert drain(client, tmp_path) == ["done"]
    srt = client.get(f"/api/v1/clips/{clip_id}/subtitles.srt")
    assert srt.status_code == 200 and srt.text.startswith("1\n00:00:00,100 --> ")
    burn = client.post(f"/api/v1/clips/{clip_id}/subtitles", json={"preset": "destaque"}, headers=h(client))
    assert burn.status_code == 202, burn.text
    if HAS_LIBASS:
        assert drain(client, tmp_path) == ["done"]
        clip = client.get(f"/api/v1/clips/{clip_id}").json()["clip"]
        assert clip["subtitled_url"] == f"/api/v1/clips/{clip_id}/media/subtitled"
        assert credits_used(client) == 27
    else:
        # FFmpeg sem libass (ex.: o do Homebrew): falha clara e o crédito volta. No Docker ele tem.
        assert drain(client, tmp_path) == ["failed"]
        assert credits_used(client) == 25

    # Aceitar conta como nota positiva da versão do prompt no teste A/B.
    stats = client.get("/api/v1/admin/ai/stats").json()["items"]
    row = next(r for r in stats if r["task"] == "highlights")
    assert row["prompt"] == "highlights:v1" and row["acceptance"] == 1.0


# ---------------------------------------------------------------- gateway


def test_reserva_entre_provedores_e_formato_validado(client, outbox, video_file, tmp_path, ai):
    make_user(client, outbox)
    video = ready(client, video_file, tmp_path)
    ai.fail = {"gemini"}
    body = {"source_kind": "video", "source_id": video["id"]}
    resp = client.post("/api/v1/ai/metadata", json=body, headers=h(client))
    assert resp.status_code == 200, resp.text
    meta = resp.json()["metadata"]
    assert meta["model"] == "anthropic:claude-haiku-5-5" and meta["hashtags"] == ["#clipo", "#cortes"]
    assert logs(client, event="metadata.attempt_failed")[0]["platform"] == "gemini"
    saved = call(client, db(client).ai_calls.find_one, {"_id": meta["call_id"]})
    assert (
        saved["fallbacks"][0]["provider"] == "gemini" and saved["cost_usd"] is None
    )  # sem preço configurado
    assert "sem preço configurado" in logs(client, event="metadata.generated")[0]["message"]

    # Todos falham (um com erro, outro fora do formato): 502 e o crédito volta.
    ai.bad = {"anthropic"}
    before = credits_used(client)
    resp = client.post("/api/v1/ai/metadata", json=body, headers=h(client))
    assert resp.status_code == 502 and resp.json()["error"]["code"] == "ai_failed"
    assert credits_used(client) == before
    assert logs(client, event="metadata.failed")


def test_sem_provedor_configurado(client, outbox, video_file, tmp_path):
    make_user(client, outbox)
    video = ready(client, video_file, tmp_path)
    resp = client.post(
        "/api/v1/ai/metadata", json={"source_kind": "video", "source_id": video["id"]}, headers=h(client)
    )
    assert resp.status_code == 503 and resp.json()["error"]["code"] == "ai_unavailable"


def test_teto_diario_de_gasto(client, outbox, video_file, tmp_path, ai):
    become_super_admin(client, outbox)
    client.put(
        "/api/v1/admin/ai/settings", json={"prices": PRICES, "daily_budget_usd": 0.01}, headers=h(client)
    )
    video = ready(client, video_file, tmp_path)
    body = {"source_kind": "video", "source_id": video["id"]}
    for _ in range(2):  # cada chamada custa ~US$ 0,0056
        assert client.post("/api/v1/ai/metadata", json=body, headers=h(client)).status_code == 200
    assert logs(client, event="budget.warning")
    resp = client.post("/api/v1/ai/metadata", json=body, headers=h(client))
    assert resp.status_code == 503 and resp.json()["error"]["code"] == "ai_budget_exceeded"
    assert logs(client, event="budget.exceeded")


def test_creditos_do_plano(client, outbox, video_file, tmp_path, ai, monkeypatch):
    make_user(client, outbox)
    _set_plan(monkeypatch, ai_credits_month=2)
    video = ready(client, video_file, tmp_path)
    body = {"source_kind": "video", "source_id": video["id"]}
    for _ in range(2):
        assert client.post("/api/v1/ai/metadata", json=body, headers=h(client)).status_code == 200
    resp = client.post("/api/v1/ai/metadata", json=body, headers=h(client))
    assert resp.status_code == 402 and resp.json()["error"]["code"] == "ai_credits_exhausted"
    assert client.get("/api/v1/ai/usage").json()["credits"] == {
        "month": f"{datetime.now(UTC):%Y-%m}",
        "used": 2,
        "limit": 2,
        "remaining": 0,
        "plan": "Básico",
    }
    # Pedido de cortes que não cabe nos créditos nem entra na fila.
    resp = client.post(f"/api/v1/videos/{video['id']}/highlights", json={}, headers=h(client))
    assert resp.status_code == 402
    assert drain(client, tmp_path) == []


def test_job_que_falha_devolve_os_creditos(client, outbox, video_file, tmp_path, ai):
    make_user(client, outbox)
    video = ready(client, video_file, tmp_path)
    ai.fail = {"gemini", "anthropic"}
    resp = client.post(
        f"/api/v1/videos/{video['id']}/highlights", json={"min_s": 5, "max_s": 15}, headers=h(client)
    )
    assert resp.status_code == 202
    assert credits_used(client) == 6  # 5 + 1 minuto de transcrição
    outcomes = []
    for _ in range(3):  # 3 tentativas com espera crescente
        call(client, db(client).jobs.update_many, {}, {"$set": {"run_at": datetime.now(UTC)}})
        outcomes += drain(client, tmp_path)
    assert outcomes[-1] == "failed"
    assert credits_used(client) == 0
    # A transcrição feita na primeira tentativa ficou guardada (não se perde nem se cobra de novo).
    assert call(client, db(client).transcripts.find_one, {"_id": video["id"]})["status"] == "ready"


# ---------------------------------------------------------------- metadados da fala e A/B


def test_metadados_usam_a_fala_e_o_teste_ab_divide_as_pessoas(client, outbox, video_file, tmp_path, ai):
    become_super_admin(client, outbox)
    v2 = client.post(
        "/api/v1/admin/ai/prompts",
        json={
            "task": "metadata",
            "system": "Sistema da versão dois.",
            "template": "Versão 2: $title / $transcript",
            "weight": 100,
        },
        headers=h(client),
    )
    assert v2.status_code == 201 and v2.json()["prompt"]["id"] == "metadata:v2"
    video = ready(client, video_file, tmp_path)
    client.post(f"/api/v1/videos/{video['id']}/transcribe", headers=h(client))
    assert drain(client, tmp_path) == ["done"]

    body = {
        "source_kind": "video",
        "source_id": video["id"],
        "tone": "educativo",
        "context": "aula de edição",
    }
    resp = client.post("/api/v1/ai/metadata", json=body, headers=h(client)).json()["metadata"]
    assert resp["used_transcript"] is True
    sent = ai.calls[-1]["human"]
    assert "palavra0_0" in sent  # a transcrição foi para a IA

    # Pessoas diferentes caem em versões diferentes (sempre a mesma para cada uma).
    seen = set()
    for n in range(8):
        client.cookies.clear()
        make_user(client, outbox, email=f"pessoa{n}@example.com")
        video_n = call(client, db(client).videos.find_one, {"_id": video["id"]})
        call(
            client,
            db(client).videos.update_one,
            {"_id": video_n["_id"]},
            {"$set": {"user_id": client.get("/api/me").json()["user"]["id"]}},
        )
        call(client, db(client).transcripts.update_one, {"_id": video_n["_id"]}, {"$set": {"user_id": "x"}})
        first = client.post("/api/v1/ai/metadata", json=body, headers=h(client)).json()["metadata"]["prompt"]
        again = client.post("/api/v1/ai/metadata", json=body, headers=h(client)).json()["metadata"]["prompt"]
        assert first == again
        seen.add(first)
    assert seen == {"metadata:v1", "metadata:v2"}


def test_admin_da_ia_exige_permissao(client, outbox):
    make_user(client, outbox)
    for method, path in (
        ("GET", "/api/v1/admin/ai/settings"),
        ("GET", "/api/v1/admin/ai/prompts"),
        ("GET", "/api/v1/admin/ai/stats"),
    ):
        assert client.request(method, path).status_code == 403


# ---------------------------------------------------------------- transcrição pela API e legendas


def test_transcricao_pela_api_em_partes(client, outbox, video_file, tmp_path, monkeypatch):
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/audio/transcriptions"
        assert request.headers["authorization"] == "Bearer chave-openai"
        sent.append({"size": len(request.content)})
        words = [{"word": "olá", "start": 1.0, "end": 1.4}, {"word": "mundo.", "start": 1.5, "end": 2.0}]
        return httpx.Response(
            200,
            json={
                "language": "portuguese",
                "duration": 30,
                "text": "olá mundo.",
                "segments": [{"start": 1.0, "end": 2.0, "text": "olá mundo."}],
                "words": words,
            },
        )

    monkeypatch.setenv("STT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "chave-openai")
    monkeypatch.setattr(transcription, "CHUNK_SECONDS", 12)
    monkeypatch.setattr(transcription, "HTTP_TRANSPORT", httpx.MockTransport(handler))
    get_settings.cache_clear()
    try:
        make_user(client, outbox)
        video = ready(client, video_file, tmp_path)
        assert client.post(f"/api/v1/videos/{video['id']}/transcribe", headers=h(client)).status_code == 202
        assert drain(client, tmp_path) == ["done"]
        assert len(sent) == 3  # 30 s em partes de 12 s
        doc = client.get(f"/api/v1/videos/{video['id']}/transcript", params={"words": "true"}).json()[
            "transcript"
        ]
        starts = [s["words"][0]["s"] for s in doc["segments"]]
        assert starts == [1.0, 13.0, 25.0]  # cada parte deslocada pelo começo dela
        assert len(logs(client, event="transcription.generated")) == 3
        vtt = client.get(f"/api/v1/videos/{video['id']}/subtitles.vtt")
        assert vtt.text.startswith("WEBVTT\n\n00:00:01.000 --> ") and "olá mundo." in vtt.text
        again = client.post(f"/api/v1/videos/{video['id']}/transcribe", headers=h(client))
        assert again.json()["error"]["code"] == "already_transcribed"
    finally:
        get_settings.cache_clear()


def test_legenda_exige_transcricao(client, outbox, video_file, tmp_path, ai):
    make_user(client, outbox)
    video = ready(client, video_file, tmp_path)
    clip = client.post(
        f"/api/v1/videos/{video['id']}/clips", json={"start_s": 0, "end_s": 5}, headers=h(client)
    ).json()["clip"]
    drain(client, tmp_path)
    resp = client.post(f"/api/v1/clips/{clip['id']}/subtitles", json={}, headers=h(client))
    assert resp.status_code == 409 and resp.json()["error"]["code"] == "no_transcript"
    assert client.get(f"/api/v1/videos/{video['id']}/subtitles.srt").status_code == 409


def test_outro_usuario_nao_ve_transcricao_nem_sugestoes(client, outbox, video_file, tmp_path, ai):
    make_user(client, outbox)
    video = ready(client, video_file, tmp_path)
    client.post(f"/api/v1/videos/{video['id']}/transcribe", headers=h(client))
    drain(client, tmp_path)
    client.cookies.clear()
    make_user(client, outbox, email="bia@example.com")
    assert client.get(f"/api/v1/videos/{video['id']}/transcript").status_code == 404
    assert client.get(f"/api/v1/videos/{video['id']}/suggestions").json() == {"items": []}
    assert (
        client.post(f"/api/v1/videos/{video['id']}/highlights", json={}, headers=h(client)).status_code == 404
    )
    assert json.dumps(client.get("/api/v1/ai/usage").json()["credits"]["used"]) == "0"

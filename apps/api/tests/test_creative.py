"""Ideias e roteiros com IA (provedor simulado) e métricas: simulador, resultados, painel e radar."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from conftest import csrf_headers, make_user

from clipo_api.core.config import get_settings
from clipo_api.services import analytics
from clipo_api.services.ai import config as ai_config
from clipo_api.services.ai import gateway
from clipo_api.services.ai.creative import BlockOut, IdeaOut, IdeasOut, ScriptOut


class FakeLLM:
    def __init__(self):
        self.calls: list[dict] = []

    async def __call__(self, provider, model, messages, schema, temperature):
        self.calls.append({"human": messages[1][1], "schema": schema.__name__})
        usage = {"input_tokens": 900, "output_tokens": 400}
        if schema is IdeasOut:
            ideas = [
                IdeaOut(
                    title=f"Ideia {i}",
                    hook="Você está editando errado.",
                    category="viral",
                    bullets=["um", "dois", "três"],
                    cta="Comente QUERO",
                    duration_s=45,
                    effort="low",
                    score=90 - i,
                    score_reason="tema em alta",
                    platforms=["tiktok", "instagram"],
                )
                for i in range(5)
            ]
            return IdeasOut(ideas=ideas), usage
        blocks = [
            BlockOut(act="Gancho", speech="Pare de editar " * 5, visual="close no rosto, praia ao fundo"),
            BlockOut(act="Solução", speech="Use cortes automáticos " * 10, visual="tela do editor"),
        ]
        return ScriptOut(blocks=blocks, retention_score=81), usage


@pytest.fixture
def ai(monkeypatch):
    fake = FakeLLM()
    monkeypatch.setenv("GEMINI_API_KEY", "chave-gemini")
    get_settings.cache_clear()
    ai_config.invalidate()
    monkeypatch.setattr(gateway, "invoke_model", fake)
    yield fake
    get_settings.cache_clear()
    ai_config.invalidate()


def h(client) -> dict:
    return csrf_headers(client)


def db(client):
    return client.app.state.mongo[get_settings().mongodb_db]


def test_ideias_da_ia_viram_roteiro_com_tempos_e_desfazer(client, outbox, ai):
    make_user(client, outbox)
    resp = client.post(
        "/api/v1/ideas/generate",
        json={"prompt": "edição com IA", "niche": "Tecnologia", "count": 3},
        headers=h(client),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert [i["title"] for i in body["items"]] == ["Ideia 0", "Ideia 1", "Ideia 2"]
    assert body["credits"]["used"] == 1
    assert "edição com IA" in ai.calls[0]["human"] and "Tecnologia" in ai.calls[0]["human"]

    idea = body["items"][0]
    client.patch(f"/api/v1/ideas/{idea['id']}", json={"saved": True}, headers=h(client))
    listing = client.get("/api/v1/ideas", params={"saved": True}).json()
    assert [i["id"] for i in listing["items"]] == [idea["id"]]
    assert listing["counts"]["all"] == 3 and listing["niches"] == ["Tecnologia"]

    script = client.post(f"/api/v1/ideas/{idea['id']}/script", headers=h(client)).json()["script"]
    assert script["retention_score"] == 81 and len(script["blocks"]) == 2
    # 15 + 30 palavras a 160 por minuto: o segundo bloco começa onde o primeiro termina.
    assert script["word_count"] == 45 and script["estimated_duration_s"] == 17
    assert script["blocks"][1]["start_s"] == script["blocks"][0]["end_s"] == 5.6
    assert client.get("/api/v1/ideas").json()["items"][0]["status"] == "scripted"

    # Edição manual muda a contagem; a IA ajusta e dá para desfazer uma vez.
    blocks = script["blocks"]
    blocks[0]["speech"] = "Fala curta"
    edited = client.patch(
        f"/api/v1/scripts/{script['id']}", json={"blocks": blocks, "status": "ready"}, headers=h(client)
    ).json()["script"]
    assert edited["word_count"] == 32 and edited["blocks"][0]["id"] == blocks[0]["id"]
    improved = client.post(
        f"/api/v1/scripts/{script['id']}/ai", json={"action": "hook"}, headers=h(client)
    ).json()
    assert improved["script"]["can_undo"] and improved["credits"]["used"] == 1 + 2 + 1
    undone = client.post(f"/api/v1/scripts/{script['id']}/undo", headers=h(client)).json()["script"]
    assert undone["blocks"][0]["speech"] == "Fala curta" and not undone["can_undo"]

    client.patch(f"/api/v1/scripts/{script['id']}", json={"status": "recorded"}, headers=h(client))
    assert (
        client.get("/api/v1/ideas", params={"status": "in_production"}).json()["counts"]["in_production"] == 1
    )


def test_broll_sugere_ativos_da_biblioteca(client, outbox, ai):
    make_user(client, outbox)
    me = client.get("/api/me").json()["user"]["id"]
    now = datetime.now(UTC)
    client.portal.call(
        db(client).assets.insert_one,
        {
            "_id": "a1",
            "user_id": me,
            "name": "Praia ao entardecer",
            "type": "video",
            "tags": ["praia", "verao"],
            "status": "ready",
            "deleted_at": None,
            "created_at": now,
        },
    )
    script = client.post(
        "/api/v1/scripts", json={"title": "Teste", "hook": "Olha isso"}, headers=h(client)
    ).json()["script"]
    out = client.post(
        f"/api/v1/scripts/{script['id']}/ai", json={"action": "broll"}, headers=h(client)
    ).json()
    assert out["asset_suggestions"] == [
        {
            "block_index": 0,
            "assets": [{"id": "a1", "name": "Praia ao entardecer", "type": "video", "thumb_url": None}],
        }
    ]


def test_sem_ia_configurada_nao_cobra(client, outbox, monkeypatch):
    make_user(client, outbox)
    for key in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LOCAL_LLM_URL"):
        monkeypatch.setenv(key, "")
    get_settings.cache_clear()
    ai_config.invalidate()
    resp = client.post("/api/v1/ideas/generate", json={}, headers=h(client))
    assert resp.status_code == 503
    assert client.get("/api/v1/ai/usage").json()["credits"]["used"] == 0
    ai_config.invalidate()


def test_simulador_coleta_e_resultados_somam_o_periodo(client, outbox):
    make_user(client, outbox)
    me = client.get("/api/me").json()["user"]["id"]
    published = datetime.now(UTC) - timedelta(days=5)
    pub_id = uuid4().hex
    target = {
        "platform": "tiktok",
        "status": "published",
        "remote_id": "x1",
        "published_at": published,
        "tags": ["ia"],
    }
    client.portal.call(
        db(client).publications.insert_one,
        {
            "_id": pub_id,
            "user_id": me,
            "source": {"kind": "video", "id": "v1"},
            "title": "Corte 1",
            "status": "published",
            "targets": [target],
            "created_at": published,
            "published_at": published,
        },
    )
    assert client.portal.call(analytics.collect_due, db(client)) == 1
    # A segunda passada no mesmo minuto não coleta de novo.
    assert client.portal.call(analytics.collect_due, db(client)) == 0
    snap = analytics.simulate(pub_id, "tiktok", published, datetime.now(UTC))

    data = client.get("/api/v1/analytics/overview", params={"period": "7d"}).json()
    assert data["simulated"] is True and data["has_data"] is True
    assert data["kpis"]["views"]["value"] == snap.views > 0
    assert data["platforms"] == [{"platform": "tiktok", "views": snap.views, "pct": 100.0}]
    assert data["top"][0]["title"] == "Corte 1" and len(data["series"]) == 7
    assert len(data["retention_curve"]) == 10 and data["retention_curve"][0] == 100.0


def test_dados_de_demonstracao_enchem_painel_e_radar(client, outbox):
    make_user(client, outbox)
    created = client.post("/api/v1/dev/demo-data", headers=h(client)).json()
    assert created["publications"] == 10
    dash = client.get("/api/v1/dashboard").json()
    assert dash["stats"]["published_30d"] >= 1 and dash["stats"]["views_7d"]["value"] > 0
    assert len(dash["views_daily"]) == 7 and dash["simulated"] is True
    assert {c["platform"] for c in dash["channels"]} >= {"tiktok", "instagram", "youtube"}
    tiktok = next(c for c in dash["channels"] if c["platform"] == "tiktok")
    assert tiktok["followers"] > 0 and tiktok["delta_7d"] >= 0

    year = client.get("/api/v1/analytics/overview", params={"period": "year"}).json()
    assert year["kpis"]["followers"]["value"] > 0 and len(year["top"]) == 6
    radar = client.get("/api/v1/ideas/radar").json()
    assert radar["items"] and all(i["keyword"].startswith("#") for i in radar["items"])

    # Criar de novo substitui; apagar limpa tudo.
    client.post("/api/v1/dev/demo-data", headers=h(client))
    assert client.delete("/api/v1/dev/demo-data", headers=h(client)).json() == {"removed": 10}
    assert client.get("/api/v1/analytics/overview").json()["has_data"] is False


def test_exporta_resultados_em_pdf_excel_e_csv(client, outbox, tmp_path):
    import io

    from openpyxl import load_workbook

    make_user(client, outbox)
    client.post("/api/v1/dev/demo-data", headers=h(client))
    pdf = client.get("/api/v1/analytics/export", params={"format": "pdf", "period": "30d"})
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    assert "clipo-resultados-30d" in pdf.headers["content-disposition"]
    (tmp_path / "r.pdf").write_bytes(pdf.content)

    xlsx = client.get("/api/v1/analytics/export", params={"format": "xlsx"})
    wb = load_workbook(io.BytesIO(xlsx.content))
    assert wb.sheetnames == ["Resumo", "Por dia", "Por rede", "Top vídeos"]
    assert any(row[0] == "Visualizações" for row in wb["Resumo"].iter_rows(values_only=True))

    text = client.get("/api/v1/analytics/export", params={"format": "csv"}).content.decode("utf-8-sig")
    assert "Visualizações;" in text and "TOP VÍDEOS" in text
    assert client.get("/api/v1/analytics/export", params={"format": "doc"}).status_code == 422

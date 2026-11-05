"""F8: Super Admin — papéis em toda rota, auditoria, pessoas, entrar como (só leitura), jobs,
integrações, painéis de erro, métricas, chaves de IA e feature flags."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from conftest import csrf_headers, make_user

from clipo_api.core.permissions import PERMISSIONS
from clipo_api.observability.logs import record
from clipo_api.services import jobs
from clipo_api.services.ai import config as ai_config
from clipo_api.services.ai import credits

PASSWORD = "senha-forte-123"


def h(client) -> dict:
    return csrf_headers(client)


def db(client):
    return client.app.state.db


def call(client, fn, *args, **kw):
    return client.portal.call(lambda: fn(*args, **kw))


def login(client, email: str) -> None:
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"email": email, "password": PASSWORD}).status_code == 200


def staff(client, outbox, role: str, email: str | None = None) -> str:
    email = email or f"{role}@example.com"
    make_user(client, outbox, email=email)
    call(client, db(client).users.update_one, {"email": email}, {"$set": {"role": role}})
    login(client, email)
    return client.get("/api/me").json()["user"]["id"]


def customer(client, outbox, email="cliente@example.com") -> str:
    client.cookies.clear()
    make_user(client, outbox, email=email)
    return client.get("/api/me").json()["user"]["id"]


def audits(client, action: str) -> list[dict]:
    return call(client, lambda: db(client).audit_logs.find({"action": action}).to_list())


def admin_routes(client) -> list[tuple[str, str]]:
    out = []
    for path, ops in client.app.openapi()["paths"].items():
        if path.startswith("/api/v1/admin/"):
            out += [(m.upper(), path) for m in ops]
    return out


# ---------------------------------------------------------------- papéis em todas as rotas


@pytest.mark.parametrize("role", ["user", "support", "admin"])
def test_toda_rota_do_admin_respeita_os_papeis(client, outbox, role):
    routes = admin_routes(client)
    assert len(routes) >= 30
    staff(client, outbox, role)
    allowed = PERMISSIONS[role]
    # Cada rota declara a permissão no código; aqui só conferimos o que um papel sem ela recebe.
    readable_by_support = {
        ("GET", "/api/v1/admin/users"),
        ("GET", "/api/v1/admin/users/{user_id}"),
        ("GET", "/api/v1/admin/jobs"),
        ("GET", "/api/v1/admin/logs"),
        ("GET", "/api/v1/admin/logs/summary"),
        ("GET", "/api/v1/admin/logs/export.csv"),
        ("GET", "/api/v1/admin/logs/integrations"),
    }
    for method, path in routes:
        resp = client.request(method, path.replace("{", "").replace("}", ""), json={}, headers=h(client))
        if role == "user":
            assert resp.status_code == 403, f"{method} {path} deixou um cliente entrar ({resp.status_code})"
        elif role == "support":
            if (method, path) in readable_by_support:
                assert resp.status_code != 403, f"{method} {path} barrou o suporte"
            else:
                assert resp.status_code == 403, f"{method} {path} deixou o suporte mexer ({resp.status_code})"
        elif "ai:manage" not in allowed and "/admin/ai/" in path:
            assert resp.status_code == 403, f"{method} {path} deixou o admin mexer na IA"
    denied = call(client, lambda: db(client).system_logs.count_documents({"event": "permission.denied"}))
    assert denied > 0


# ---------------------------------------------------------------- pessoas


def test_busca_detalhe_suspender_e_reativar(client, outbox):
    target = customer(client, outbox, "ana@example.com")
    pub = {
        "_id": "p1",
        "user_id": target,
        "status": "scheduled",
        "targets": [],
        "title": "x",
        "source": {"kind": "video", "id": "v"},
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }
    call(client, db(client).publications.insert_one, pub)
    customer(client, outbox, "bruno@example.com")
    staff(client, outbox, "admin")

    found = client.get("/api/v1/admin/users", params={"q": "ANA@"}).json()
    assert [u["email"] for u in found["items"]] == ["ana@example.com"] and found["total"] == 1
    assert found["items"][0]["last_active_at"] is not None
    assert {
        u["email"] for u in client.get("/api/v1/admin/users", params={"role": "user"}).json()["items"]
    } == {"ana@example.com", "bruno@example.com"}

    detail = client.get(f"/api/v1/admin/users/{target}").json()
    assert detail["user"]["email"] == "ana@example.com" and detail["subscription"]["status"] == "trialing"
    assert detail["ai_credits"]["limit"] == 100 and detail["counts"]["publications"] == {"scheduled": 1}
    assert {c["platform"] for c in detail["connections"]} == {"youtube", "instagram", "tiktok"}

    resp = client.post(
        f"/api/v1/admin/users/{target}/suspend", json={"reason": "pagamento contestado"}, headers=h(client)
    )
    assert resp.status_code == 200 and resp.json()["publications_paused"] == 1
    assert call(client, db(client).sessions.count_documents, {"user_id": target, "revoked_at": None}) == 0
    assert call(client, db(client).publications.find_one, {"_id": "p1"})["status"] == "draft"
    assert audits(client, "user.suspended")[0]["details"]["reason"] == "pagamento contestado"
    again = client.post(
        f"/api/v1/admin/users/{target}/suspend", json={"reason": "de novo"}, headers=h(client)
    )
    assert again.status_code == 409

    client.cookies.clear()
    blocked = client.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD})
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "account_suspended"

    login(client, "admin@example.com")
    assert client.post(f"/api/v1/admin/users/{target}/reactivate", headers=h(client)).status_code == 200
    assert audits(client, "user.reactivated")
    login(client, "ana@example.com")


def test_admin_nao_suspende_quem_tem_papel_igual_ou_maior(client, outbox):
    boss = staff(client, outbox, "super_admin", "chefe@example.com")
    peer = staff(client, outbox, "admin", "colega@example.com")
    me = staff(client, outbox, "admin", "eu@example.com")
    for target in (boss, peer, me):
        resp = client.post(
            f"/api/v1/admin/users/{target}/suspend", json={"reason": "teste"}, headers=h(client)
        )
        assert resp.status_code == 403
    login(client, "chefe@example.com")
    assert (
        client.post(
            f"/api/v1/admin/users/{peer}/suspend", json={"reason": "teste"}, headers=h(client)
        ).status_code
        == 200
    )


def test_creditos_extras_de_ia(client, outbox):
    target = customer(client, outbox)
    staff(client, outbox, "admin")
    resp = client.post(
        f"/api/v1/admin/users/{target}/credits", json={"amount": 50, "reason": "cortesia"}, headers=h(client)
    )
    assert resp.status_code == 200 and resp.json()["credits"]["limit"] == 150
    assert call(client, credits.usage, db(client), target)["remaining"] == 150
    assert audits(client, "user.credits_granted")[0]["details"] == {"amount": 50, "reason": "cortesia"}


# ---------------------------------------------------------------- entrar como a pessoa


def test_entrar_como_a_pessoa_so_leitura_com_auditoria(client, outbox):
    target = customer(client, outbox, "ana@example.com")
    staff(client, outbox, "admin")
    resp = client.post(
        f"/api/v1/admin/users/{target}/impersonate", json={"reason": "chamado #42"}, headers=h(client)
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["read_only"] is True
    bearer = {"Authorization": f"Bearer {data['access_token']}"}
    admin_cookies = dict(client.cookies)

    client.cookies.clear()
    me = client.get("/api/me", headers=bearer)
    assert me.status_code == 200 and me.json()["user"]["email"] == "ana@example.com"
    assert client.get("/api/v1/videos", headers=bearer).status_code == 200
    # Nada que mude a conta passa (nem com CSRF válido: o token é de leitura).
    changed = client.patch(
        "/api/v1/account", json={"name": "Hacker"}, headers={**bearer, "X-CSRF-Token": "x"}
    )
    assert changed.status_code in (403,)
    blocked = call(client, lambda: db(client).system_logs.find_one({"event": "impersonation.blocked"}))
    assert blocked["user_id"] == target and blocked["details"]["path"] == "/api/v1/account"
    assert (
        call(client, lambda: db(client).system_logs.count_documents({"event": "impersonation.request"})) >= 2
    )

    # A pessoa vê a sessão do suporte na lista de aparelhos.
    login(client, "ana@example.com")
    kinds = [s["kind"] for s in client.get("/api/v1/account/sessions").json()["items"]]
    assert "support" in kinds

    client.cookies.clear()
    client.cookies.update(admin_cookies)
    active = client.get("/api/v1/admin/impersonations").json()["items"]
    assert active[0]["user_id"] == target and active[0]["reason"] == "chamado #42"
    assert (
        client.delete(f"/api/v1/admin/impersonations/{data['session_id']}", headers=h(client)).status_code
        == 200
    )
    client.cookies.clear()
    assert client.get("/api/me", headers=bearer).status_code == 401
    assert audits(client, "impersonation.started") and audits(client, "impersonation.stopped")


def test_nao_entra_como_outro_admin(client, outbox):
    other = staff(client, outbox, "support", "suporte@example.com")
    staff(client, outbox, "admin")
    resp = client.post(
        f"/api/v1/admin/users/{other}/impersonate", json={"reason": "curiosidade"}, headers=h(client)
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------- fila de jobs


def test_fila_repetir_e_cancelar(client, outbox):
    target = customer(client, outbox)
    call(client, credits.reserve, db(client), target, 6, "teste")
    queued = call(
        client,
        jobs.enqueue,
        db(client),
        "video.transcribe",
        target,
        {"video_id": "v1", "credits": 6, "credits_month": f"{datetime.now(UTC):%Y-%m}"},
    )
    failed = call(client, jobs.enqueue, db(client), "diagnostic.run", target, {"diagnostic_id": "d1"})
    call(
        client,
        db(client).jobs.update_one,
        {"_id": failed["_id"]},
        {"$set": {"status": "failed", "attempts": 3, "error": "boom", "finished_at": datetime.now(UTC)}},
    )
    pub = call(client, jobs.enqueue, db(client), "publication.publish", target, {"publication_id": "p"})
    call(client, db(client).jobs.update_one, {"_id": pub["_id"]}, {"$set": {"status": "failed"}})

    staff(client, outbox, "support", "suporte@example.com")
    listed = client.get("/api/v1/admin/jobs", params={"status": "failed"}).json()
    assert {j["id"] for j in listed["items"]} == {failed["_id"], pub["_id"]}
    assert listed["items"][0]["user_id"] == target
    assert client.post(f"/api/v1/admin/jobs/{failed['_id']}/retry", headers=h(client)).status_code == 403

    staff(client, outbox, "admin")
    retried = client.post(f"/api/v1/admin/jobs/{failed['_id']}/retry", headers=h(client))
    assert retried.status_code == 200 and retried.json()["job"]["status"] == "queued"
    assert retried.json()["job"]["attempts"] == 0
    assert (
        client.post(f"/api/v1/admin/jobs/{pub['_id']}/retry", headers=h(client)).json()["error"]["code"]
        == "use_publication_retry"
    )

    # Cancelar na fila devolve os créditos reservados (nenhum worker vai rodar a limpeza).
    assert call(client, credits.usage, db(client), target)["used"] == 6
    cancelled = client.post(f"/api/v1/admin/jobs/{queued['_id']}/cancel", headers=h(client))
    assert cancelled.json()["job"]["status"] == "cancelled"
    assert call(client, credits.usage, db(client), target)["used"] == 0
    assert client.post(f"/api/v1/admin/jobs/{queued['_id']}/cancel", headers=h(client)).status_code == 409
    assert audits(client, "job.retried") and audits(client, "job.cancelled")


# ---------------------------------------------------------------- integrações, erros e métricas


def test_integracoes_painel_de_erros_e_metricas(client, outbox):
    target = customer(client, outbox)

    async def seed():
        for _ in range(3):
            await record("integration", "http.request", "POST tiktok → 500", level="error", platform="tiktok")
        await record("integration", "http.request", "GET youtube → 200", platform="youtube")
        await db(client).payments.insert_one(
            {
                "_id": "pay1",
                "user_id": target,
                "value_cents": 5990,
                "net_cents": 5700,
                "applied_at": datetime.now(UTC),
                "created_at": datetime.now(UTC),
            }
        )
        await db(client).subscriptions.update_one(
            {"_id": target},
            {
                "$set": {
                    "status": "active",
                    "plan_id": "pro",
                    "cycle": "monthly",
                    "asaas_subscription_id": "sub_1",
                    "current_period_end": datetime.now(UTC) + timedelta(days=20),
                }
            },
        )
        now = datetime.now(UTC)
        await db(client).publications.insert_one(
            {
                "_id": "p",
                "user_id": target,
                "status": "partial",
                "updated_at": now,
                "targets": [{"status": "published"}, {"status": "failed"}],
            }
        )
        await db(client).ai_calls.insert_one(
            {"_id": "c", "task": "metadata", "cost_usd": 0.01, "created_at": now}
        )

    client.portal.call(seed)
    staff(client, outbox, "admin")
    panel = client.get("/api/v1/admin/logs/integrations", params={"hours": 24}).json()
    assert panel["platforms"]["tiktok"]["errors"] == 3 and panel["platforms"]["youtube"]["error_rate"] == 0
    assert panel["top_errors"][0] == {
        **panel["top_errors"][0],
        "platform": "tiktok",
        "event": "http.request",
        "count": 3,
    }
    assert sum(p["errors"] for p in panel["series"] if p["platform"] == "tiktok") == 3

    health = client.get("/api/v1/admin/integrations").json()
    tiktok = next(n for n in health["networks"] if n["platform"] == "tiktok")
    assert tiktok["errors_24h"] == 3 and tiktok["last_error"]["message"] == "POST tiktok → 500"
    assert health["payments"]["gateway"] == "simulado"

    m = client.get("/api/v1/admin/metrics", params={"days": 30}).json()
    assert m["users"]["total"] == 2 and m["users"]["active_1d"] == 2
    assert m["subscriptions"]["mrr_cents"] == 5990 and m["revenue"]["gross"] == 5990
    assert m["publications"]["failure_rate"] == 0.5 and m["ai"]["cost_usd"] == 0.01


# ---------------------------------------------------------------- IA: chaves pelo admin


def test_chaves_de_ia_pelo_admin_ficam_criptografadas(client, outbox):
    staff(client, outbox, "super_admin")
    resp = client.put(
        "/api/v1/admin/ai/keys", json={"gemini": "AIzaSy-chave-de-teste-9876"}, headers=h(client)
    )
    assert resp.status_code == 200, resp.text
    gemini = resp.json()["settings"]["providers"]["gemini"]
    assert gemini == {"ready": True, "source": "admin", "key": "…9876"}
    stored = call(client, db(client).ai_settings.find_one, {"_id": "default"})
    assert "chave-de-teste" not in json.dumps(stored, default=str)
    assert "chave-de-teste" not in json.dumps(audits(client, "ai.keys_updated"), default=str)
    assert (
        ai_config.key_for("gemini", call(client, ai_config.load, db(client))) == "AIzaSy-chave-de-teste-9876"
    )
    cleared = client.put("/api/v1/admin/ai/keys", json={"gemini": ""}, headers=h(client)).json()
    assert cleared["settings"]["providers"]["gemini"]["ready"] is False
    ai_config.invalidate()


# ---------------------------------------------------------------- feature flags


def test_feature_flags(client, outbox):
    ana = customer(client, outbox, "ana@example.com")
    customer(client, outbox, "bia@example.com")
    staff(client, outbox, "super_admin")
    body = {"enabled": True, "description": "Editor novo", "rollout_percent": 0, "user_ids": [ana]}
    assert client.put("/api/v1/admin/flags/editor-novo", json=body, headers=h(client)).status_code == 200
    client.put("/api/v1/admin/flags/so-pro", json={"enabled": True, "plan_ids": ["pro"]}, headers=h(client))
    assert {f["key"] for f in client.get("/api/v1/admin/flags").json()["items"]} == {"editor-novo", "so-pro"}
    assert audits(client, "flag.created")

    login(client, "ana@example.com")
    assert client.get("/api/v1/me/flags").json()["flags"] == {"editor-novo": True, "so-pro": False}
    login(client, "bia@example.com")
    assert client.get("/api/v1/me/flags").json()["flags"]["editor-novo"] is False

    login(client, "super_admin@example.com")
    assert client.delete("/api/v1/admin/flags/editor-novo", headers=h(client)).status_code == 200
    assert client.delete("/api/v1/admin/flags/editor-novo", headers=h(client)).status_code == 404


def test_toda_rota_do_admin_que_muda_algo_grava_auditoria(client):
    """Conferência no código: rota nova do admin sem auditoria quebra este teste."""
    import inspect

    from fastapi.routing import APIRoute

    from clipo_api.services import billing

    # Rotas que delegam a auditoria para o serviço (que audita lá dentro).
    delegated = {"admin_grant_plan": billing.grant_manual, "admin_refund": billing.refund}
    checked = 0
    # FastAPI 0.162 embrulha cada router incluído; as rotas de verdade ficam no router original.
    routes = [
        r for inc in client.app.routes for r in getattr(getattr(inc, "original_router", None), "routes", [])
    ]
    for route in routes:
        if not isinstance(route, APIRoute) or not route.path.startswith("/api/v1/admin/"):
            continue
        if not route.methods & {"POST", "PUT", "PATCH", "DELETE"}:
            continue
        source = inspect.getsource(delegated.get(route.endpoint.__name__, route.endpoint))
        assert "audit(" in source, f"{route.methods} {route.path} não grava auditoria"
        checked += 1
    assert checked >= 18

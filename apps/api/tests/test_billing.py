"""F6: planos, checkout no Asaas, webhook, teste grátis, cupons, inadimplência, cancelamento e cotas."""

import json
from collections import Counter
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from conftest import csrf_headers, make_user
from test_connections import run_diagnostic

from clipo_api.core.config import get_settings
from clipo_api.services import asaas, billing, diagnostics, notifications

CPF = "529.982.247-25"  # CPF válido de exemplo (dígitos conferem)
TOKEN = "token-do-webhook"


class FakeAsaas:
    def __init__(self):
        self.calls: Counter = Counter()
        self.bodies: list[tuple[str, str, dict]] = []
        self.subs: dict[str, dict] = {}
        self.n = 0
        self.fail_customer = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["access_token"] == "chave-sandbox"
        path, method = request.url.path.removeprefix("/v3"), request.method
        body = json.loads(request.content) if request.content else {}
        self.calls[f"{method} {path}"] += 1
        self.bodies.append((method, path, body))
        if path == "/customers":
            if self.fail_customer:
                return httpx.Response(
                    400, json={"errors": [{"code": "invalid_cpfCnpj", "description": "CPF inválido"}]}
                )
            return httpx.Response(200, json={"id": "cus_1", **body})
        if path == "/subscriptions" and method == "POST":
            self.n += 1
            sub_id = f"sub_{self.n}"
            self.subs[sub_id] = body
            return httpx.Response(200, json={"id": sub_id, "status": "ACTIVE", **body})
        if path.endswith("/payments") and method == "GET":
            sub_id = path.split("/")[2]
            sub = self.subs[sub_id]
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": f"pay_{sub_id}_1",
                            "subscription": sub_id,
                            "value": sub["value"],
                            "status": "PENDING",
                            "dueDate": sub["nextDueDate"],
                            "invoiceUrl": f"https://sandbox.asaas.com/i/{sub_id}",
                        }
                    ]
                },
            )
        if path.startswith("/subscriptions/") and method == "DELETE":
            return httpx.Response(200, json={"deleted": True})
        if path.startswith("/subscriptions/") and method == "POST":
            self.subs[path.split("/")[2]].update(body)
            return httpx.Response(200, json={"id": path.split("/")[2], **body})
        if path.endswith("/refund"):
            return httpx.Response(200, json={"id": path.split("/")[2], "status": "REFUNDED"})
        if path.startswith("/payments/") and method == "POST":
            return httpx.Response(200, json={"id": path.split("/")[2], **body})
        if path == "/finance/balance":
            return httpx.Response(200, json={"balance": 123.45})
        raise AssertionError(f"chamada inesperada ao Asaas: {method} {path}")


@pytest.fixture
def gateway(monkeypatch):
    fake = FakeAsaas()
    monkeypatch.setenv("ASAAS_API_KEY", "chave-sandbox")
    monkeypatch.setenv("ASAAS_WEBHOOK_TOKEN", TOKEN)
    get_settings.cache_clear()
    monkeypatch.setattr(asaas, "HTTP_TRANSPORT", httpx.MockTransport(fake.handler))
    yield fake
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def mails(monkeypatch):
    sent: list[dict] = []

    async def capture(to, title, body, url, action_label):
        sent.append({"to": to, "title": title})

    monkeypatch.setattr(notifications, "send_notification_email", capture)
    return sent


def h(client) -> dict:
    return csrf_headers(client)


def db(client):
    return client.app.state.db


def call(client, fn, *args, **kw):
    return client.portal.call(lambda: fn(*args, **kw))


def summary(client) -> dict:
    resp = client.get("/api/v1/billing")
    assert resp.status_code == 200, resp.text
    return resp.json()


def checkout(client, plan="pro", cycle="monthly", **body) -> dict:
    resp = client.post(
        "/api/v1/billing/checkout",
        json={"plan_id": plan, "cycle": cycle, "document": CPF, **body},
        headers=h(client),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def webhook(
    client, event: str, payment_id: str, sub_id: str, *, value=59.9, due=None, event_id=None, token=TOKEN
):
    payload = {
        "id": event_id or f"evt_{event}_{payment_id}",
        "event": event,
        "payment": {
            "id": payment_id,
            "subscription": sub_id,
            "value": value,
            "netValue": value,
            "billingType": "PIX",
            "status": event.removeprefix("PAYMENT_"),
            "dueDate": due or billing.today_br().isoformat(),
            "invoiceUrl": "https://sandbox.asaas.com/i/x",
        },
    }
    return client.post("/api/v1/webhooks/asaas", json=payload, headers={"asaas-access-token": token})


def me_plan(client) -> str:
    return client.get("/api/me").json()["user"]["plan_id"]


def bell(client) -> list[dict]:
    return client.get("/api/v1/notifications").json()["items"]


def logs(client, **query) -> list[dict]:
    return call(client, lambda: db(client).system_logs.find(query).to_list())


def user_id(client) -> str:
    return client.get("/api/me").json()["user"]["id"]


def set_sub(client, **fields) -> None:
    call(client, db(client).subscriptions.update_one, {"_id": user_id(client)}, {"$set": fields})


def sweep(client) -> int:
    return call(client, billing.sweep, db(client))


def make_admin(client, outbox) -> None:
    make_user(client, outbox, email="admin@example.com")
    call(client, db(client).users.update_one, {"email": "admin@example.com"}, {"$set": {"role": "admin"}})
    # O papel vai no token de acesso: entra de novo para valer.
    resp = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "senha-forte-123"})
    assert resp.status_code == 200


# ---------------------------------------------------------------- critério de saída


def test_pagamento_ativa_pelo_webhook_e_cancelamento_rebaixa_no_fim(client, outbox, gateway):
    make_user(client, outbox)
    start = summary(client)
    assert start["subscription"]["status"] == "trialing" and me_plan(client) == "basico"

    out = checkout(client, "pro", "monthly")
    assert out["invoice_url"] == "https://sandbox.asaas.com/i/sub_1"
    # Checkout aberto não muda o plano: ainda no teste.
    assert out["subscription"]["status"] == "trialing" and out["subscription"]["checkout"]["plan_id"] == "pro"
    created = next(b for m, p, b in gateway.bodies if p == "/subscriptions")
    assert (
        created["value"] == 59.9 and created["cycle"] == "MONTHLY" and created["billingType"] == "UNDEFINED"
    )
    customer = next(b for m, p, b in gateway.bodies if p == "/customers")
    assert customer["cpfCnpj"] == "52998224725"

    # O Asaas confirma o pagamento pelo webhook → plano ativo.
    assert webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1").json()["outcome"] == "activated"
    paid = summary(client)
    assert paid["subscription"]["status"] == "active" and paid["subscription"]["checkout"] is None
    assert me_plan(client) == "pro" and paid["plan"]["social_accounts"] == 3
    assert paid["payments"][0]["value_cents"] == 5990
    assert bell(client)[0]["title"] == "Plano Pro ativado"
    assert logs(client, event="subscription.activated")

    # Cancela: para as cobranças no Asaas, mas o plano vale até o fim do período.
    resp = client.post("/api/v1/billing/cancel", headers=h(client))
    assert resp.status_code == 200, resp.text
    assert gateway.calls["DELETE /subscriptions/sub_1"] == 1
    cancelled = resp.json()["subscription"]
    assert cancelled["status"] == "active" and cancelled["cancel_at_period_end"] is True
    assert me_plan(client) == "pro"
    assert sweep(client) == 0

    # Fim do período: o worker rebaixa.
    set_sub(client, current_period_end=datetime.now(UTC) - timedelta(minutes=1))
    assert sweep(client) == 1
    assert summary(client)["subscription"]["status"] == "expired" and me_plan(client) == "gratis"
    assert bell(client)[0]["title"] == "Assinatura encerrada"
    assert logs(client, event="subscription.expired")


# ---------------------------------------------------------------- webhook


def test_webhook_exige_token_e_nao_processa_duas_vezes(client, outbox, gateway):
    make_user(client, outbox)
    checkout(client)
    assert webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1", token="").status_code == 401
    assert webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1", token="errado").status_code == 401
    assert logs(client, event="asaas.rejected")
    assert me_plan(client) == "basico"

    # Cartão: CONFIRMED e depois RECEIVED da mesma cobrança. Aplica uma vez só.
    assert webhook(client, "PAYMENT_CONFIRMED", "pay_sub_1_1", "sub_1").json()["outcome"] == "activated"
    assert webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1").json()["outcome"] == "already_applied"
    # O mesmo evento reenviado pelo Asaas.
    assert webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1").json()["outcome"] == "duplicate"
    assert [n["title"] for n in bell(client)].count("Plano Pro ativado") == 1

    # Cobrança de uma assinatura que o Clipo não conhece: registrado como erro, sem quebrar.
    assert (
        webhook(client, "PAYMENT_RECEIVED", "pay_x", "sub_desconhecida").json()["outcome"]
        == "unknown_subscription"
    )
    assert logs(client, event="webhook.unknown_subscription")


def test_webhook_sem_token_configurado_recusa(client, outbox):
    resp = webhook(client, "PAYMENT_RECEIVED", "p", "s", token="qualquer")
    assert resp.status_code == 401


# ---------------------------------------------------------------- renovação e inadimplência


def test_atraso_tolerancia_e_rebaixamento(client, outbox, gateway):
    make_user(client, outbox)
    checkout(client)
    webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1")
    first_end = datetime.fromisoformat(summary(client)["subscription"]["current_period_end"])

    # Renovação atrasou: mantém o plano no prazo de tolerância e avisa.
    assert webhook(client, "PAYMENT_OVERDUE", "pay_sub_1_2", "sub_1").json()["outcome"] == "past_due"
    late = summary(client)["subscription"]
    assert late["status"] == "past_due" and me_plan(client) == "pro"
    grace = datetime.fromisoformat(late["grace_ends_at"])
    assert timedelta(days=4, hours=23) < grace - datetime.now(UTC) <= timedelta(days=5)
    assert bell(client)[0]["title"] == "Pagamento atrasado"

    # Pagou dentro do prazo: volta a ativa e o período anda um mês.
    due = (first_end.astimezone(billing.BR).date()).isoformat()
    assert webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_2", "sub_1", due=due).json()["outcome"] == "renewed"
    renewed = summary(client)["subscription"]
    assert renewed["status"] == "active" and renewed["grace_ends_at"] is None
    assert datetime.fromisoformat(renewed["current_period_end"]) > first_end + timedelta(days=27)

    # Atrasa de novo e não paga: no fim do prazo vai para o gratuito e a assinatura no Asaas para.
    webhook(client, "PAYMENT_OVERDUE", "pay_sub_1_3", "sub_1")
    set_sub(client, grace_ends_at=datetime.now(UTC) - timedelta(minutes=1))
    assert sweep(client) == 1
    assert me_plan(client) == "gratis" and summary(client)["subscription"]["status"] == "expired"
    assert gateway.calls["DELETE /subscriptions/sub_1"] == 1
    assert bell(client)[0]["title"] == "Plano rebaixado por falta de pagamento"


def test_teste_gratis_avisa_antes_e_acaba(client, outbox, gateway):
    make_user(client, outbox)
    plans_out = client.get("/api/v1/plans").json()
    assert plans_out["trial"] == {"plan_id": "basico", "days": 7}
    assert [p["id"] for p in plans_out["items"]] == ["basico", "pro", "premium"]  # o gratuito não é vendido
    set_sub(client, trial_ends_at=datetime.now(UTC) + timedelta(days=1))
    sweep(client)
    assert bell(client)[0]["title"] == "Seu teste grátis acaba em breve"
    sweep(client)
    assert len(bell(client)) == 1  # o aviso não se repete
    set_sub(client, trial_ends_at=datetime.now(UTC) - timedelta(seconds=1))
    assert sweep(client) == 1
    assert me_plan(client) == "gratis"
    assert bell(client)[0]["title"] == "Seu teste grátis acabou"


def test_sem_teste_gratis_conta_nova_ja_e_gratuita(client, outbox, monkeypatch):
    monkeypatch.setenv("TRIAL_DAYS", "0")
    get_settings.cache_clear()
    try:
        make_user(client, outbox)
        assert me_plan(client) == "gratis"
        assert client.get("/api/v1/plans").json()["trial"] is None
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------- troca de plano


def test_subir_vale_na_hora_e_descer_no_fim_do_periodo(client, outbox, gateway):
    make_user(client, outbox)
    checkout(client, "basico")
    webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1", value=29.9)
    assert me_plan(client) == "basico"

    up = client.post("/api/v1/billing/change-plan", json={"plan_id": "premium"}, headers=h(client))
    assert up.status_code == 200, up.text
    assert me_plan(client) == "premium"
    assert gateway.subs["sub_1"]["value"] == 99.9 and gateway.subs["sub_1"]["updatePendingPayments"] is True

    down = client.post("/api/v1/billing/change-plan", json={"plan_id": "pro"}, headers=h(client)).json()
    assert me_plan(client) == "premium" and down["subscription"]["pending_plan_id"] == "pro"
    assert gateway.subs["sub_1"]["value"] == 59.9
    set_sub(client, pending_from=datetime.now(UTC) - timedelta(seconds=1))
    sweep(client)
    assert me_plan(client) == "pro" and summary(client)["subscription"]["pending_plan_id"] is None

    # Já assinante não abre outro checkout (evita cobrar duas vezes).
    again = client.post(
        "/api/v1/billing/checkout", json={"plan_id": "premium", "document": CPF}, headers=h(client)
    )
    assert again.status_code == 409 and again.json()["error"]["code"] == "already_subscribed"


def test_cancelar_e_retomar_antes_do_fim(client, outbox, gateway):
    make_user(client, outbox)
    checkout(client)
    webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1")
    client.post("/api/v1/billing/cancel", headers=h(client))
    resumed = client.post("/api/v1/billing/resume", headers=h(client))
    assert resumed.status_code == 200, resumed.text
    sub = resumed.json()["subscription"]
    assert sub["cancel_at_period_end"] is False
    # Nova assinatura no Asaas começando no fim do período já pago (não cobra de novo agora).
    assert gateway.subs["sub_2"]["nextDueDate"] == (
        datetime.fromisoformat(sub["current_period_end"]).astimezone(billing.BR).date().isoformat()
    )
    set_sub(client, current_period_end=datetime.now(UTC) - timedelta(minutes=1))
    webhook(client, "PAYMENT_RECEIVED", "pay_sub_2_1", "sub_2")
    assert me_plan(client) == "pro"


# ---------------------------------------------------------------- cupons


def test_cupons(client, outbox, gateway):
    make_admin(client, outbox)

    def coupon(**body):
        resp = client.post("/api/v1/admin/coupons", json=body, headers=h(client))
        assert resp.status_code == 201, resp.text

    coupon(code="metade", kind="percent", value=50, duration="once")
    coupon(code="SEMPRE10", kind="amount", value=1000, duration="forever", plan_ids=["pro"])
    coupon(code="UMSO", kind="percent", value=10, max_redemptions=1)
    coupon(
        code="VENCIDO",
        kind="percent",
        value=10,
        expires_at=(datetime.now(UTC) - timedelta(days=1)).isoformat(),
    )
    coupon(code="GRATIS", kind="percent", value=100, duration="once")
    coupon(code="QUASE", kind="amount", value=2600, duration="once", plan_ids=["basico"])
    assert (
        client.post(
            "/api/v1/admin/coupons", json={"code": "METADE", "kind": "percent", "value": 5}, headers=h(client)
        ).status_code
        == 409
    )

    client.cookies.clear()
    make_user(client, outbox)
    check = client.post(
        "/api/v1/billing/coupon", json={"code": "metade", "plan_id": "pro"}, headers=h(client)
    ).json()
    assert check == {
        "code": "METADE",
        "duration": "once",
        "price_cents": 5990,
        "first_charge_cents": 2995,
        "recurring_cents": 5990,
    }

    def err(**body):
        resp = client.post("/api/v1/billing/checkout", json={"document": CPF, **body}, headers=h(client))
        assert resp.status_code in (409, 422), resp.text
        return resp.json()["error"]["code"]

    assert err(plan_id="pro", coupon="VENCIDO") == "invalid_coupon"
    assert err(plan_id="pro", coupon="NAOEXISTE") == "invalid_coupon"
    assert err(plan_id="premium", coupon="SEMPRE10") == "coupon_not_for_plan"
    assert err(plan_id="basico", coupon="QUASE") == "below_minimum"

    # Só na primeira cobrança: a assinatura fica no valor cheio e a 1ª fatura sai pela metade.
    out = checkout(client, "pro", coupon="metade")
    assert gateway.subs["sub_1"]["value"] == 59.9
    assert ("POST", "/payments/pay_sub_1_1", {"value": 29.95}) in gateway.bodies
    assert out["subscription"]["checkout"]["first_charge_cents"] == 2995

    # Trocar o checkout por um cupom que vale sempre: cancela o anterior no Asaas.
    checkout(client, "pro", coupon="SEMPRE10")
    assert gateway.calls["DELETE /subscriptions/sub_1"] == 1
    assert gateway.subs["sub_2"]["value"] == 49.9

    # Limite de usos.
    client.cookies.clear()
    make_user(client, outbox, email="bia@example.com")
    checkout(client, "pro", coupon="UMSO")
    client.cookies.clear()
    make_user(client, outbox, email="caio@example.com")
    assert err(plan_id="pro", coupon="UMSO") == "invalid_coupon"

    # 100% na primeira: ativa já, sem fatura, e a cobrança começa no próximo ciclo.
    out = checkout(client, "pro", coupon="GRATIS")
    assert out["invoice_url"] is None and me_plan(client) == "pro"
    assert out["subscription"]["status"] == "active"


# ---------------------------------------------------------------- dados de pagamento e erros


def test_documento_e_erros_do_gateway(client, outbox, gateway):
    make_user(client, outbox)
    no_doc = client.post("/api/v1/billing/checkout", json={"plan_id": "pro"}, headers=h(client))
    assert no_doc.json()["error"]["code"] == "document_required"
    bad = client.post(
        "/api/v1/billing/checkout", json={"plan_id": "pro", "document": "111.111.111-11"}, headers=h(client)
    )
    assert bad.json()["error"]["code"] == "invalid_document"
    hidden = client.post(
        "/api/v1/billing/checkout", json={"plan_id": "gratis", "document": CPF}, headers=h(client)
    )
    assert hidden.json()["error"]["code"] == "plan_not_available"

    gateway.fail_customer = True
    resp = client.post(
        "/api/v1/billing/checkout", json={"plan_id": "pro", "document": CPF}, headers=h(client)
    )
    assert resp.status_code == 502 and "CPF inválido" in resp.json()["error"]["message"]
    assert logs(client, event="checkout.failed")
    # O CPF completo não fica guardado no Clipo, só os 4 últimos dígitos.
    gateway.fail_customer = False
    checkout(client)
    stored = call(client, db(client).subscriptions.find_one, {})
    assert stored["document_last4"] == "4725" and "52998224725" not in json.dumps(stored, default=str)


def test_reembolso_pelo_admin_rebaixa_quando_o_webhook_chega(client, outbox, gateway):
    make_user(client, outbox)
    checkout(client)
    webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1")
    client.cookies.clear()
    make_admin(client, outbox)
    resp = client.post("/api/v1/admin/payments/pay_sub_1_1/refund", headers=h(client))
    assert resp.status_code == 200, resp.text
    assert gateway.calls["POST /payments/pay_sub_1_1/refund"] == 1
    assert webhook(client, "PAYMENT_REFUNDED", "pay_sub_1_1", "sub_1").json()["outcome"] == "refunded_expired"
    ana = call(client, db(client).users.find_one, {"email": "ana@example.com"})
    assert ana["plan_id"] == "gratis"
    assert call(client, db(client).audit_logs.find_one, {"action": "billing.refund"})


# ---------------------------------------------------------------- admin: planos e cortesia


def test_admin_muda_plano_e_da_cortesia(client, outbox, gateway):
    make_user(client, outbox, email="ana@example.com")
    assert client.get("/api/v1/admin/plans").status_code == 403
    ana_id = user_id(client)
    client.cookies.clear()
    make_admin(client, outbox)

    listed = {p["id"]: p for p in client.get("/api/v1/admin/plans").json()["items"]}
    assert listed["gratis"]["public"] is False and listed["basico"]["users"] == 2
    pro = {k: v for k, v in listed["pro"].items() if k not in ("id", "users")}
    resp = client.put(
        "/api/v1/admin/plans/pro",
        json={**pro, "price_monthly_cents": 6990, "social_accounts": 5},
        headers=h(client),
    )
    assert resp.status_code == 200, resp.text
    public = {p["id"]: p for p in client.get("/api/v1/plans").json()["items"]}
    assert public["pro"]["price_monthly_cents"] == 6990 and public["pro"]["social_accounts"] == 5
    bad = client.put("/api/v1/admin/plans/pro", json={**pro, "price_monthly_cents": 100}, headers=h(client))
    assert bad.status_code == 422
    assert call(client, db(client).audit_logs.find_one, {"action": "plan.updated"})

    grant = client.put(
        f"/api/v1/admin/users/{ana_id}/plan", json={"plan_id": "premium", "days": 30}, headers=h(client)
    )
    assert grant.status_code == 200, grant.text
    ana = call(client, db(client).users.find_one, {"_id": ana_id})
    assert ana["plan_id"] == "premium"
    call(
        client,
        db(client).subscriptions.update_one,
        {"_id": ana_id},
        {"$set": {"manual_until": datetime.now(UTC) - timedelta(seconds=1)}},
    )
    sweep(client)
    assert call(client, db(client).users.find_one, {"_id": ana_id})["plan_id"] == "gratis"


# ---------------------------------------------------------------- modo simulado e diagnóstico


def test_sem_chave_o_asaas_e_simulado_para_desenvolver(client, outbox):
    make_user(client, outbox)
    assert summary(client)["gateway"] == "simulado"
    out = checkout(client, "premium", "yearly")
    assert "fatura_simulada=" in out["invoice_url"]
    paid = client.post("/api/v1/billing/dev/pay", json={}, headers=h(client))
    assert paid.status_code == 200, paid.text
    assert paid.json()["outcome"] == "activated" and me_plan(client) == "premium"
    end = datetime.fromisoformat(paid.json()["subscription"]["current_period_end"])
    assert end - datetime.now(UTC) > timedelta(days=364)
    assert logs(client, platform="asaas-simulado")


def test_rota_de_simulacao_nao_existe_com_asaas_de_verdade(client, outbox, gateway):
    make_user(client, outbox)
    assert client.post("/api/v1/billing/dev/pay", json={}, headers=h(client)).status_code == 404


def test_diagnostico_do_asaas(client, outbox, gateway, tmp_path, monkeypatch):
    make_user(client, outbox)
    monkeypatch.setattr(diagnostics, "API_TRANSPORT", httpx.ASGITransport(app=client.app))
    diag = run_diagnostic(client, tmp_path, "payments")
    assert diag["status"] == "passed", diag["steps"]
    messages = {s["name"]: s["message"] for s in diag["steps"]}
    assert "sandbox" in messages["Chave do Asaas"] and "123.45" in messages["Conexão com a API"]
    assert me_plan(client) == "basico"


# ---------------------------------------------------------------- cotas por plano


def test_limite_de_contas_sociais_do_plano(client, outbox, monkeypatch):
    from conftest import allow_social_accounts
    from test_connections import FakeNetworks, connect

    from clipo_api.services.connectors import base as connectors_base

    fake = FakeNetworks()
    for name, value in {
        "YOUTUBE_CLIENT_ID": "a",
        "YOUTUBE_CLIENT_SECRET": "b",
        "TIKTOK_CLIENT_KEY": "c",
        "TIKTOK_CLIENT_SECRET": "d",
    }.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    monkeypatch.setattr(connectors_base, "HTTP_TRANSPORT", httpx.MockTransport(fake.handler))
    try:
        make_user(client, outbox)
        connect(client, "youtube")
        blocked = client.get("/api/v1/connections/tiktok/connect", follow_redirects=False)
        assert "connection_error=plan_limit" in blocked.headers["location"]
        # Reconectar a rede que já está no plano continua valendo.
        assert (
            "state="
            in client.get("/api/v1/connections/youtube/connect", follow_redirects=False).headers["location"]
        )
        allow_social_accounts(monkeypatch, 2)
        connect(client, "tiktok")
        assert logs(client, event="connect.plan_limit")
    finally:
        get_settings.cache_clear()


def test_conta_com_plano_sem_assinatura_nao_perde_o_plano_ao_abrir_checkout(client, outbox, gateway):
    make_user(client, outbox)
    # Como a conta de teste do seed: plano gravado na conta, sem assinatura.
    call(client, db(client).subscriptions.delete_one, {"_id": user_id(client)})
    call(client, db(client).users.update_one, {"_id": user_id(client)}, {"$set": {"plan_id": "premium"}})
    out = checkout(client, "pro")
    assert out["subscription"]["status"] == "manual" and me_plan(client) == "premium"
    webhook(client, "PAYMENT_RECEIVED", "pay_sub_1_1", "sub_1")
    assert me_plan(client) == "pro"


def test_assinatura_da_cobranca_antiga_e_convertida(client, outbox):
    from clipo_api.db.mongo import ensure_schema

    make_user(client, outbox)
    uid = user_id(client)
    call(
        client,
        db(client).subscriptions.update_one,
        {"_id": uid},
        {"$set": {"status": "ativa", "plan_id": "pro"}},
    )
    call(client, ensure_schema, db(client))
    sub = call(client, db(client).subscriptions.find_one, {"_id": uid})
    assert sub["status"] == "manual" and sub["plan_id"] == "pro"

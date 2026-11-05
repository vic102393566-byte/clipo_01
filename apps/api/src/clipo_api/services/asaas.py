"""Cliente da API v3 do Asaas (cobrança recorrente com Pix, boleto e cartão).

A pessoa paga na fatura do próprio Asaas (`invoiceUrl`): o Clipo nunca vê número de cartão.
Toda chamada passa pelo `LoggedClient`, então fica no log do sistema (categoria payment).
"""

import json
from datetime import UTC, date, datetime
from typing import Any
from uuid import uuid4

import httpx

from clipo_api.core.config import get_settings
from clipo_api.observability.http import LoggedClient

BASE_URLS = {"sandbox": "https://api-sandbox.asaas.com/v3", "production": "https://api.asaas.com/v3"}
CYCLES = {"monthly": "MONTHLY", "yearly": "YEARLY"}
# Os testes trocam o transporte para simular o Asaas.
HTTP_TRANSPORT: httpx.AsyncBaseTransport | None = None


class AsaasError(Exception):
    def __init__(self, code: str, message: str, *, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable


def configured() -> bool:
    return bool(get_settings().asaas_api_key)


def mode() -> str:
    """asaas (chave configurada), simulado (desenvolvimento sem chave) ou off (produção sem chave)."""
    s = get_settings()
    if s.asaas_api_key:
        return "asaas"
    return "off" if s.is_production else "simulado"


def _simulator(request: httpx.Request) -> httpx.Response:
    """Asaas de mentira para desenvolver sem conta: responde no formato real, não cobra nada.

    A "fatura" aponta para a própria tela de plano; o pagamento é confirmado pela rota de
    desenvolvimento /api/v1/billing/dev/pay, que passa pelo mesmo código do webhook real.
    """
    path, method = request.url.path.removeprefix("/v3"), request.method
    body = json.loads(request.content or b"{}") if request.content else {}
    if path == "/customers" and method == "POST":
        return httpx.Response(200, json={"id": f"cus_sim_{uuid4().hex[:10]}", **body})
    if path == "/subscriptions" and method == "POST":
        return httpx.Response(200, json={"id": f"sub_sim_{uuid4().hex[:10]}", "status": "ACTIVE", **body})
    if path.startswith("/subscriptions/") and path.endswith("/payments"):
        sub_id = path.split("/")[2]
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": f"pay_{sub_id}_1",
                        "subscription": sub_id,
                        "status": "PENDING",
                        "value": 0,
                        "dueDate": datetime.now(UTC).date().isoformat(),
                        "invoiceUrl": f"{get_settings().app_base_url}/plano?fatura_simulada={sub_id}",
                    }
                ]
            },
        )
    if path.startswith("/subscriptions/") and method == "DELETE":
        return httpx.Response(200, json={"deleted": True, "id": path.split("/")[2]})
    if path.startswith(("/subscriptions/", "/payments/")):
        return httpx.Response(
            200, json={"id": path.split("/")[2], "status": "REFUNDED" if "refund" in path else "OK", **body}
        )
    if path == "/finance/balance":
        return httpx.Response(200, json={"balance": 0})
    return httpx.Response(404, json={"errors": [{"code": "not_found", "description": "simulador"}]})


def _client() -> LoggedClient:
    s = get_settings()
    current = mode()
    if current == "off":
        raise AsaasError("not_configured", "O Asaas não está configurado (ASAAS_API_KEY).")
    transport = HTTP_TRANSPORT or (httpx.MockTransport(_simulator) if current == "simulado" else None)
    return LoggedClient(
        platform="asaas" if current == "asaas" else "asaas-simulado",
        category="payment",
        base_url=BASE_URLS[s.asaas_environment],
        headers={
            "access_token": s.asaas_api_key or "simulado",
            "User-Agent": "Clipo",
            "Content-Type": "application/json",
        },
        transport=transport,
        timeout=httpx.Timeout(30.0),
    )


def _check(resp: httpx.Response, what: str) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if resp.status_code == 401:
        raise AsaasError("unauthorized", "A chave da API do Asaas foi recusada.", status=401)
    if resp.status_code >= 400:
        errors = data.get("errors") if isinstance(data, dict) else None
        first = errors[0] if errors else {}
        raise AsaasError(
            first.get("code") or "asaas_error",
            f"{what}: {first.get('description') or f'HTTP {resp.status_code}'}",
            status=resp.status_code,
            retryable=resp.status_code >= 500 or resp.status_code == 429,
        )
    return data if isinstance(data, dict) else {}


async def _call(method: str, path: str, what: str, **kw: Any) -> dict[str, Any]:
    async with _client() as http:
        return _check(await http.request(method, path, **kw), what)


async def create_customer(name: str, email: str, document: str, external_id: str) -> dict[str, Any]:
    return await _call(
        "POST",
        "/customers",
        "Cadastro do cliente no Asaas",
        json={
            "name": name,
            "email": email,
            "cpfCnpj": document,
            "externalReference": external_id,
            "notificationDisabled": True,  # os avisos saem do Clipo
        },
    )


async def create_subscription(
    customer_id: str,
    *,
    value_cents: int,
    cycle: str,
    billing_type: str,
    next_due: date,
    description: str,
    external_id: str,
) -> dict[str, Any]:
    return await _call(
        "POST",
        "/subscriptions",
        "Criação da assinatura no Asaas",
        json={
            "customer": customer_id,
            "billingType": billing_type,
            "value": value_cents / 100,
            "nextDueDate": next_due.isoformat(),
            "cycle": CYCLES[cycle],
            "description": description[:500],
            "externalReference": external_id,
        },
    )


async def update_subscription(subscription_id: str, *, value_cents: int, cycle: str) -> dict[str, Any]:
    return await _call(
        "POST",
        f"/subscriptions/{subscription_id}",
        "Troca de plano no Asaas",
        json={"value": value_cents / 100, "cycle": CYCLES[cycle], "updatePendingPayments": True},
    )


async def cancel_subscription(subscription_id: str) -> None:
    async with _client() as http:
        resp = await http.delete(f"/subscriptions/{subscription_id}")
    if resp.status_code != 404:  # já não existe: dá no mesmo
        _check(resp, "Cancelamento da assinatura no Asaas")


async def subscription_payments(subscription_id: str) -> list[dict[str, Any]]:
    data = await _call("GET", f"/subscriptions/{subscription_id}/payments", "Cobranças da assinatura")
    return data.get("data") or []


async def update_payment_value(payment_id: str, value_cents: int) -> dict[str, Any]:
    return await _call(
        "POST", f"/payments/{payment_id}", "Desconto na primeira cobrança", json={"value": value_cents / 100}
    )


async def refund_payment(payment_id: str, value_cents: int | None = None) -> dict[str, Any]:
    body = {"value": value_cents / 100} if value_cents else {}
    return await _call("POST", f"/payments/{payment_id}/refund", "Reembolso no Asaas", json=body)


async def balance() -> dict[str, Any]:
    return await _call("GET", "/finance/balance", "Saldo da conta Asaas")

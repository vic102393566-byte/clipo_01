"""API v1 de planos e cobrança (Asaas), o webhook do Asaas e a gestão de planos e cupons no admin.

Substitui as rotas antigas /api/subscription/* e /api/webhook/payment.
"""

import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, Field, model_validator
from pymongo import ReturnDocument

from clipo_api.core.auth import AuthUser
from clipo_api.core.config import get_settings
from clipo_api.core.errors import ApiError
from clipo_api.core.permissions import Requires
from clipo_api.core.plans import FREE_PLAN_ID, Plan, all_plans, get_plan, invalidate, public_plan
from clipo_api.core.ratelimit import client_ip, hit
from clipo_api.db.mongo import MongoDb
from clipo_api.observability.logs import audit, record
from clipo_api.services import asaas, billing, quota

router = APIRouter(prefix="/api/v1", tags=["plano"])

Cycle = Literal["monthly", "yearly"]
BillingType = Literal["UNDEFINED", "PIX", "BOLETO", "CREDIT_CARD"]
PlanId = Annotated[str, Field(pattern=r"^[a-z0-9_-]{2,30}$")]


def _api_error(exc: billing.BillingError | asaas.AsaasError) -> ApiError:
    if isinstance(exc, billing.BillingError):
        return ApiError(exc.status, exc.code, exc.message)
    if exc.code == "not_configured":
        return ApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE, "billing_unavailable", "Cobrança indisponível agora."
        )
    return ApiError(status.HTTP_502_BAD_GATEWAY, "gateway_error", exc.message)


def _iso(v: Any) -> Any:
    return v.isoformat() if isinstance(v, datetime) else v


async def _user(db: MongoDb, user_id: str) -> dict[str, Any]:
    return await db.users.find_one({"_id": user_id}, projection={"name": 1, "email": 1, "plan_id": 1})


async def _summary(db: MongoDb, user_id: str) -> dict[str, Any]:
    user = await _user(db, user_id)
    sub = await billing.get_subscription(db, user_id)
    plan = await get_plan(db, user["plan_id"])
    payments = await db.payments.find({"user_id": user_id}).sort("created_at", -1).limit(24).to_list()
    return {
        "gateway": asaas.mode(),
        "subscription": billing.public_subscription(sub, user["plan_id"]),
        "plan": public_plan(plan),
        "usage": (await quota.usage(db, user_id)).as_dict(),
        "payments": [
            {
                "id": p["_id"],
                "value_cents": p.get("value_cents"),
                "status": p.get("status"),
                "billing_type": p.get("billing_type"),
                "due_date": p.get("due_date"),
                "invoice_url": p.get("invoice_url"),
                "refunded": bool(p.get("refunded_at")),
                "created_at": _iso(p.get("created_at")),
            }
            for p in payments
        ],
    }


# ---------------------------------------------------------------- vitrine e conta


@router.get("/plans")
async def list_plans(db: MongoDb) -> dict[str, Any]:
    """Planos à venda (pública: a página de preços usa sem login)."""
    plans = sorted(
        (p for p in (await all_plans(db)).values() if p.public and p.active), key=lambda p: p.order
    )
    s = get_settings()
    return {
        "items": [public_plan(p) for p in plans],
        "trial": {"plan_id": s.trial_plan_id, "days": s.trial_days} if s.trial_days > 0 else None,
    }


@router.get("/billing")
async def get_billing(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    return await _summary(db, user.id)


class CheckoutIn(BaseModel):
    plan_id: PlanId
    cycle: Cycle = "monthly"
    billing_type: BillingType = "UNDEFINED"
    document: Annotated[str, Field(max_length=20)] | None = None
    coupon: Annotated[str, Field(max_length=40)] | None = None


@router.post("/billing/checkout")
async def start_checkout(body: CheckoutIn, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    """Abre a cobrança no Asaas e devolve o link da fatura (Pix, boleto ou cartão)."""
    await hit(db, "checkout:user", user.id, limit=10, window_seconds=3600)
    try:
        result = await billing.checkout(
            db,
            await _user(db, user.id),
            body.plan_id,
            body.cycle,
            body.billing_type,
            body.document,
            body.coupon,
        )
    except (billing.BillingError, asaas.AsaasError) as exc:
        await record(
            "payment",
            "checkout.failed",
            exc.message[:300],
            level="warning",
            outcome="failure",
            details={"plan": body.plan_id, "code": exc.code},
        )
        raise _api_error(exc) from exc
    return {"invoice_url": result["invoice_url"], **await _summary(db, user.id)}


class CouponCheckIn(BaseModel):
    code: Annotated[str, Field(min_length=2, max_length=40)]
    plan_id: PlanId
    cycle: Cycle = "monthly"


@router.post("/billing/coupon")
async def check_coupon(body: CouponCheckIn, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    await hit(db, "coupon:user", user.id, limit=20, window_seconds=600)
    plan = await get_plan(db, body.plan_id)
    try:
        coupon = await billing.find_coupon(db, body.code, plan, body.cycle)
    except billing.BillingError as exc:
        raise _api_error(exc) from exc
    value, first = billing.price_for(plan, body.cycle, coupon)
    return {
        "code": coupon["_id"],
        "duration": coupon["duration"],
        "price_cents": plan.price_cents(body.cycle),
        "first_charge_cents": first,
        "recurring_cents": value,
    }


class ChangeIn(BaseModel):
    plan_id: PlanId
    cycle: Cycle = "monthly"


@router.post("/billing/change-plan")
async def change_plan(body: ChangeIn, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    """Subir de plano vale na hora; descer ou trocar o ciclo vale no fim do período pago."""
    try:
        await billing.change_plan(db, user.id, body.plan_id, body.cycle)
    except (billing.BillingError, asaas.AsaasError) as exc:
        raise _api_error(exc) from exc
    return await _summary(db, user.id)


@router.post("/billing/cancel")
async def cancel(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    try:
        await billing.cancel(db, user.id)
    except (billing.BillingError, asaas.AsaasError) as exc:
        raise _api_error(exc) from exc
    return await _summary(db, user.id)


@router.post("/billing/resume")
async def resume(user: AuthUser, db: MongoDb) -> dict[str, Any]:
    try:
        await billing.resume(db, user.id)
    except (billing.BillingError, asaas.AsaasError) as exc:
        raise _api_error(exc) from exc
    return await _summary(db, user.id)


class DevPayIn(BaseModel):
    event: Literal["PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_REFUNDED"] = "PAYMENT_RECEIVED"


@router.post("/billing/dev/pay", include_in_schema=False)
async def dev_pay(body: DevPayIn, user: AuthUser, db: MongoDb) -> dict[str, Any]:
    """Só com o Asaas simulado: faz de conta que o Asaas mandou o webhook (mesmo código do real).

    PAYMENT_RECEIVED paga o checkout aberto (ou a renovação); PAYMENT_OVERDUE atrasa a renovação;
    PAYMENT_REFUNDED devolve o último pagamento.
    """
    if asaas.mode() != "simulado":
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Rota não encontrada.")
    sub = await billing.get_subscription(db, user.id) or {}
    checkout_ = sub.get("checkout")
    last = await db.payments.find_one({"user_id": user.id}, sort=[("created_at", -1)])
    today = billing.today_br()
    if body.event == "PAYMENT_RECEIVED" and checkout_:
        remote, pay_id, value, due = (
            checkout_["asaas_subscription_id"],
            checkout_["payment_id"],
            checkout_["first_charge_cents"],
            today,
        )
    elif body.event == "PAYMENT_REFUNDED" and last:
        remote, pay_id, value = last["asaas_subscription_id"], last["_id"], last.get("value_cents") or 0
        due = datetime.fromisoformat(last["due_date"]).date() if last.get("due_date") else today
    elif sub.get("asaas_subscription_id") and sub.get("current_period_end"):
        remote = sub["asaas_subscription_id"]
        due = sub["current_period_end"].astimezone(billing.BR).date()
        pay_id, value = f"pay_{remote}_{due:%Y%m%d}", (last or {}).get("value_cents") or 0
    else:
        raise ApiError(status.HTTP_409_CONFLICT, "nothing_to_pay", "Não há cobrança aberta.")
    payload = {
        "id": f"evt_sim_{secrets.token_hex(6)}",
        "event": body.event,
        "payment": {
            "id": pay_id,
            "subscription": remote,
            "value": value / 100,
            "netValue": value / 100,
            "billingType": "PIX",
            "status": {"PAYMENT_RECEIVED": "RECEIVED", "PAYMENT_OVERDUE": "OVERDUE"}.get(
                body.event, "REFUNDED"
            ),
            "dueDate": due.isoformat(),
        },
    }
    outcome = await billing.handle_event(db, payload)
    return {"outcome": outcome, **await _summary(db, user.id)}


# ---------------------------------------------------------------- webhook do Asaas


@router.post("/webhooks/asaas", include_in_schema=False)
async def asaas_webhook(request: Request, db: MongoDb) -> dict[str, Any]:
    token = get_settings().asaas_webhook_token
    given = request.headers.get("asaas-access-token", "")
    body = await request.body()
    if not token or not secrets.compare_digest(given, token):
        await record(
            "webhook",
            "asaas.rejected",
            "Webhook do Asaas sem token válido"
            if token
            else "Webhook do Asaas sem ASAAS_WEBHOOK_TOKEN no .env",
            level="error",
            outcome="denied",
            platform="asaas",
            details={"ip": client_ip(request), "bytes": len(body)},
        )
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "invalid_token", "Token inválido.")
    try:
        payload = await request.json()
    except ValueError as exc:
        raise ApiError(status.HTTP_400_BAD_REQUEST, "invalid_payload", "Corpo inválido.") from exc
    event = str(payload.get("event") or "unknown")
    if event == "CLIPO_DIAGNOSTIC":
        # Evento do botão de testes: prova que o token e o processamento funcionam, sem mudar nada.
        await record(
            "webhook", "asaas.received", "Evento de teste do diagnóstico", outcome="success", platform="asaas"
        )
        return {"received": True, "diagnostic": True}
    # Erro aqui devolve 500 e o Asaas manda de novo depois (o evento só é marcado como visto no fim).
    outcome = await billing.handle_event(db, payload)
    payment = payload.get("payment") or {}
    unknown = outcome == "unknown_subscription"
    await record(
        "webhook",
        f"asaas.{event.lower()}",
        f"Evento do Asaas: {event} → {outcome}",
        level="error" if unknown else "info",
        outcome="failure" if unknown else "success",
        platform="asaas",
        details={
            "payment_id": payment.get("id"),
            "subscription": payment.get("subscription"),
            "outcome": outcome,
        },
    )
    return {"received": True, "outcome": outcome}


# ---------------------------------------------------------------- admin: planos, cupons, cortesia, reembolso


class PlanIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=60)]
    storage_bytes: Annotated[int, Field(ge=0)]
    max_file_bytes: Annotated[int, Field(ge=0)]
    max_duration_seconds: Annotated[int, Field(ge=0)]
    videos_per_month: Annotated[int, Field(ge=0)]
    social_accounts: Annotated[int, Field(ge=0, le=20)]
    price_monthly_cents: Annotated[int, Field(ge=0)] = 0
    price_yearly_cents: Annotated[int, Field(ge=0)] = 0
    ai_credits_month: Annotated[int, Field(ge=0)] = 0
    public: bool = True
    active: bool = True
    order: int = 0
    features: Annotated[list[Annotated[str, Field(max_length=120)]], Field(max_length=20)] = []

    @model_validator(mode="after")
    def _prices(self) -> "PlanIn":
        for cents in (self.price_monthly_cents, self.price_yearly_cents):
            if 0 < cents < billing.MIN_CHARGE_CENTS:
                raise ValueError("Preço abaixo do mínimo de R$ 5,00 do gateway.")
        return self


@router.get("/admin/plans")
async def admin_list_plans(user: Requires("plans:manage"), db: MongoDb) -> dict[str, Any]:
    plans = sorted((await all_plans(db)).values(), key=lambda p: p.order)
    rows = await (await db.users.aggregate([{"$group": {"_id": "$plan_id", "n": {"$sum": 1}}}])).to_list()
    counts = {r["_id"]: r["n"] for r in rows}
    return {"items": [{**public_plan(p), "users": counts.get(p.id, 0)} for p in plans]}


@router.put("/admin/plans/{plan_id}")
async def admin_put_plan(
    plan_id: PlanId, body: PlanIn, user: Requires("plans:manage"), db: MongoDb
) -> dict[str, Any]:
    """Cria ou muda um plano. Preço novo vale para checkouts novos; quem já assina segue no valor atual."""
    if plan_id == FREE_PLAN_ID and (body.price_monthly_cents or body.price_yearly_cents):
        raise ApiError(status.HTTP_422_UNPROCESSABLE_ENTITY, "free_plan", "O plano gratuito não tem preço.")
    before = await db.plans.find_one({"_id": plan_id})
    doc = Plan(id=plan_id, **{**body.model_dump(), "features": tuple(body.features)}).as_doc()
    await db.plans.replace_one({"_id": plan_id}, doc, upsert=True)
    invalidate()
    await audit(
        "plan.updated" if before else "plan.created",
        details={"plan": plan_id, "before": before, "after": doc},
    )
    return {"plan": public_plan(await get_plan(db, plan_id))}


class CouponIn(BaseModel):
    code: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{3,40}$")]
    kind: Literal["percent", "amount"]
    value: Annotated[int, Field(gt=0)]  # percentual (1-100) ou centavos
    duration: Literal["once", "forever"] = "once"
    plan_ids: list[PlanId] = []
    cycles: list[Cycle] = []
    max_redemptions: Annotated[int, Field(ge=1)] | None = None
    expires_at: datetime | None = None
    active: bool = True

    @model_validator(mode="after")
    def _percent(self) -> "CouponIn":
        if self.kind == "percent" and self.value > 100:
            raise ValueError("Percentual entre 1 e 100.")
        return self


def _coupon_out(c: dict[str, Any]) -> dict[str, Any]:
    return {**{k: _iso(v) for k, v in c.items() if k != "_id"}, "code": c["_id"]}


def _aware(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=UTC) if value and value.tzinfo is None else value


@router.get("/admin/coupons")
async def admin_list_coupons(user: Requires("plans:manage"), db: MongoDb) -> dict[str, Any]:
    items = await db.coupons.find({}).sort("created_at", -1).to_list(500)
    return {"items": [_coupon_out(c) for c in items]}


@router.post("/admin/coupons", status_code=status.HTTP_201_CREATED)
async def admin_create_coupon(body: CouponIn, user: Requires("plans:manage"), db: MongoDb) -> dict[str, Any]:
    code = body.code.upper()
    if await db.coupons.find_one({"_id": code}):
        raise ApiError(status.HTTP_409_CONFLICT, "coupon_exists", "Já existe um cupom com esse código.")
    doc = {
        **body.model_dump(exclude={"code"}),
        "_id": code,
        "expires_at": _aware(body.expires_at),
        "redemptions": 0,
        "created_at": datetime.now(UTC),
        "created_by": user.id,
    }
    await db.coupons.insert_one(doc)
    await audit("coupon.created", details={"code": code, "kind": body.kind, "value": body.value})
    return {"coupon": _coupon_out(doc)}


class CouponPatch(BaseModel):
    active: bool | None = None
    max_redemptions: Annotated[int, Field(ge=1)] | None = None
    expires_at: datetime | None = None


@router.patch("/admin/coupons/{code}")
async def admin_patch_coupon(
    code: str, body: CouponPatch, user: Requires("plans:manage"), db: MongoDb
) -> dict[str, Any]:
    changes = body.model_dump(exclude_none=True)
    if "expires_at" in changes:
        changes["expires_at"] = _aware(changes["expires_at"])
    coupon = await db.coupons.find_one_and_update(
        {"_id": code.upper()}, {"$set": changes}, return_document=ReturnDocument.AFTER
    )
    if coupon is None:
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Cupom não encontrado.")
    await audit("coupon.updated", details={"code": coupon["_id"], **{k: _iso(v) for k, v in changes.items()}})
    return {"coupon": _coupon_out(coupon)}


class GrantIn(BaseModel):
    plan_id: PlanId
    days: Annotated[int, Field(ge=1, le=3650)] | None = None  # sem prazo quando vazio


@router.put("/admin/users/{user_id}/plan")
async def admin_grant_plan(
    user_id: str, body: GrantIn, user: Requires("plans:manage"), db: MongoDb
) -> dict[str, Any]:
    """Plano cortesia (parceiro, suporte, teste interno), sem cobrança."""
    if not await db.users.find_one({"_id": user_id}, projection={"_id": 1}):
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Conta não encontrada.")
    until = datetime.now(UTC) + timedelta(days=body.days) if body.days else None
    try:
        sub = await billing.grant_manual(db, user_id, body.plan_id, until, user.id)
    except billing.BillingError as exc:
        raise _api_error(exc) from exc
    return {"subscription": billing.public_subscription(sub, sub["plan_id"])}


@router.post("/admin/payments/{payment_id}/refund")
async def admin_refund(payment_id: str, user: Requires("plans:manage"), db: MongoDb) -> dict[str, Any]:
    try:
        return await billing.refund(db, payment_id, user.id)
    except (billing.BillingError, asaas.AsaasError) as exc:
        raise _api_error(exc) from exc

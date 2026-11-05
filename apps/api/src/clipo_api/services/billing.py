"""Assinaturas: teste grátis, checkout no Asaas, troca de plano, cancelamento, inadimplência e cupons.

Estados da assinatura (coleção `subscriptions`, uma por pessoa, `_id` = id da pessoa):
- trialing: teste grátis até `trial_ends_at`
- active: paga até `current_period_end`
- past_due: cobrança atrasada; mantém o plano até `grace_ends_at` (prazo de tolerância)
- manual: plano dado pelo admin (opcionalmente até `manual_until`)
- expired: sem plano pago; vale o plano gratuito

Um checkout aberto fica em `checkout` sem mudar o estado: quem está no teste continua no teste até
pagar. O plano só muda quando o webhook do Asaas confirma o pagamento.

O plano que vale (o que as cotas usam) é gravado em `users.plan_id` a cada mudança.
"""

import calendar
import contextlib
import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from clipo_api.core.config import get_settings
from clipo_api.core.plans import FREE_PLAN_ID, Plan, get_plan
from clipo_api.observability.logs import audit, record
from clipo_api.services import asaas, notifications

BR = ZoneInfo("America/Sao_Paulo")
MIN_CHARGE_CENTS = 500  # o Asaas não emite cobrança abaixo de R$ 5,00
PAID_STATES = ("active", "past_due")
PLAN_STATES = ("trialing", "active", "past_due", "manual")
BILLING_TYPES = ("UNDEFINED", "PIX", "BOLETO", "CREDIT_CARD")


class BillingError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _now() -> datetime:
    return datetime.now(UTC)


def _brl(cents: int) -> str:
    return f"R$ {cents / 100:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


# ---------------------------------------------------------------- datas e documento


def add_cycle(day: date, cycle: str) -> date:
    months = 12 if cycle == "yearly" else 1
    month = day.month - 1 + months
    year, month = day.year + month // 12, month % 12 + 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def end_of_day(day: date) -> datetime:
    """Vencimentos do Asaas são datas no horário de Brasília: o dia vale até 23:59 de lá."""
    return datetime.combine(day, time(23, 59, 59), tzinfo=BR).astimezone(UTC)


def today_br() -> date:
    return _now().astimezone(BR).date()


def _cpf_ok(d: str) -> bool:
    if len(set(d)) == 1:
        return False
    for size in (9, 10):
        total = sum(int(d[i]) * (size + 1 - i) for i in range(size))
        if int(d[size]) != (total * 10 % 11) % 10:
            return False
    return True


def _cnpj_ok(d: str) -> bool:
    if len(set(d)) == 1:
        return False
    for size in (12, 13):
        weights = (
            [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] if size == 12 else [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        )
        rest = sum(int(d[i]) * weights[i] for i in range(size)) % 11
        if int(d[size]) != (0 if rest < 2 else 11 - rest):
            return False
    return True


def clean_document(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if (len(digits) == 11 and _cpf_ok(digits)) or (len(digits) == 14 and _cnpj_ok(digits)):
        return digits
    raise BillingError("invalid_document", "CPF ou CNPJ inválido.")


# ---------------------------------------------------------------- leitura e gravação


async def get_subscription(db: AsyncDatabase, user_id: str) -> dict[str, Any] | None:
    return await db.subscriptions.find_one({"_id": user_id})


def effective_plan_id(sub: dict[str, Any] | None, fallback: str | None = None) -> str:
    if sub is None:
        return fallback or FREE_PLAN_ID  # conta sem assinatura: plano gravado na conta (ex.: seed)
    return sub["plan_id"] if sub["status"] in PLAN_STATES else FREE_PLAN_ID


async def _save(
    db: AsyncDatabase,
    user_id: str,
    fields: dict[str, Any],
    event: str,
    message: str,
    *,
    unset: tuple[str, ...] = (),
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = _now()
    update: dict[str, Any] = {
        "$set": {**fields, "updated_at": now},
        "$push": {
            "history": {
                "$each": [{"event": event, "at": now, **(details or {})}],
                "$position": 0,
                "$slice": 50,
            }
        },
        "$setOnInsert": {"user_id": user_id, "created_at": now},
    }
    if unset:
        update["$unset"] = dict.fromkeys(unset, "")
    sub = await db.subscriptions.find_one_and_update(
        {"_id": user_id}, update, upsert=True, return_document=ReturnDocument.AFTER
    )
    plan_id = effective_plan_id(sub)
    await db.users.update_one({"_id": user_id}, {"$set": {"plan_id": plan_id}})
    await record(
        "payment",
        f"subscription.{event}",
        message,
        outcome="success",
        user_id=user_id,
        details={
            "status": sub["status"],
            "plan": sub.get("plan_id"),
            "effective_plan": plan_id,
            **(details or {}),
        },
    )
    return sub


async def _notify(db: AsyncDatabase, user_id: str, title: str, body: str, key: str) -> None:
    await notifications.notify(db, user_id, "billing", title, body, "/plano", dedupe_key=key)


# ---------------------------------------------------------------- conta nova: teste grátis


async def on_user_created(db: AsyncDatabase, user_id: str) -> None:
    s = get_settings()
    if s.trial_days <= 0:
        await db.users.update_one({"_id": user_id}, {"$set": {"plan_id": FREE_PLAN_ID}})
        return
    plan = await get_plan(db, s.trial_plan_id)
    ends = _now() + timedelta(days=s.trial_days)
    await _save(
        db,
        user_id,
        {
            "status": "trialing",
            "plan_id": plan.id,
            "cycle": "monthly",
            "trial_ends_at": ends,
            "trial_used": True,
        },
        "trial_started",
        f"Teste grátis do plano {plan.name} por {s.trial_days} dias",
        details={"trial_ends_at": ends.isoformat()},
    )


# ---------------------------------------------------------------- cupons


def _discount(coupon: dict[str, Any], price_cents: int) -> int:
    if coupon["kind"] == "percent":
        return min(price_cents, round(price_cents * coupon["value"] / 100))
    return min(price_cents, coupon["value"])


async def find_coupon(db: AsyncDatabase, code: str, plan: Plan, cycle: str) -> dict[str, Any]:
    coupon = await db.coupons.find_one({"_id": code.strip().upper()})
    now = _now()
    if (
        coupon is None
        or not coupon.get("active", True)
        or (coupon.get("expires_at") and coupon["expires_at"] < now)
        or (coupon.get("max_redemptions") and coupon.get("redemptions", 0) >= coupon["max_redemptions"])
    ):
        raise BillingError("invalid_coupon", "Cupom inválido ou esgotado.")
    if coupon.get("plan_ids") and plan.id not in coupon["plan_ids"]:
        raise BillingError("coupon_not_for_plan", f"Este cupom não vale para o plano {plan.name}.")
    if coupon.get("cycles") and cycle not in coupon["cycles"]:
        raise BillingError("coupon_not_for_cycle", "Este cupom não vale para este ciclo de cobrança.")
    return coupon


async def _redeem(db: AsyncDatabase, coupon: dict[str, Any], user_id: str) -> bool:
    """Conta o uso uma vez por pessoa, sem passar do limite mesmo com pedidos simultâneos."""
    try:
        await db.coupon_redemptions.insert_one(
            {"_id": f"{coupon['_id']}:{user_id}", "coupon": coupon["_id"], "user_id": user_id, "at": _now()}
        )
    except DuplicateKeyError:
        return True  # a mesma pessoa refazendo o checkout
    query: dict[str, Any] = {"_id": coupon["_id"]}
    if coupon.get("max_redemptions"):
        query["redemptions"] = {"$lt": coupon["max_redemptions"]}
    if await db.coupons.find_one_and_update(query, {"$inc": {"redemptions": 1}}) is None:
        await db.coupon_redemptions.delete_one({"_id": f"{coupon['_id']}:{user_id}"})
        return False
    return True


def price_for(plan: Plan, cycle: str, coupon: dict[str, Any] | None) -> tuple[int, int]:
    """(valor da assinatura, valor da primeira cobrança), em centavos."""
    full = plan.price_cents(cycle)
    if not coupon:
        return full, full
    off = full - _discount(coupon, full)
    return (off, off) if coupon["duration"] == "forever" else (full, off)


# ---------------------------------------------------------------- checkout


async def checkout(
    db: AsyncDatabase,
    user: dict[str, Any],
    plan_id: str,
    cycle: str,
    billing_type: str,
    document: str | None,
    coupon_code: str | None,
) -> dict[str, Any]:
    plan = await get_plan(db, plan_id)
    if plan.id != plan_id or not plan.public or not plan.active or plan.price_cents(cycle) <= 0:
        raise BillingError("plan_not_available", "Este plano não está à venda.")
    sub = await get_subscription(db, user["_id"]) or {}
    if sub.get("status") in PAID_STATES and sub.get("asaas_subscription_id"):
        raise BillingError("already_subscribed", "Você já tem uma assinatura. Use a troca de plano.", 409)

    coupon = await find_coupon(db, coupon_code, plan, cycle) if coupon_code else None
    value, first = price_for(plan, cycle, coupon)
    if 0 < first < MIN_CHARGE_CENTS or (
        value < MIN_CHARGE_CENTS and coupon and coupon["duration"] == "forever"
    ):
        raise BillingError(
            "below_minimum", f"O valor da cobrança não pode ficar abaixo de {_brl(MIN_CHARGE_CENTS)}."
        )

    customer_id = sub.get("asaas_customer_id")
    if not customer_id:
        if not document:
            raise BillingError("document_required", "Informe o CPF ou CNPJ de quem paga.")
        doc = clean_document(document)
        customer = await asaas.create_customer(user["name"], user["email"], doc, user["_id"])
        customer_id = customer["id"]
        await db.subscriptions.update_one(
            {"_id": user["_id"]},
            {
                "$set": {"asaas_customer_id": customer_id, "document_last4": doc[-4:]},
                # Conta sem assinatura ainda (plano gravado direto na conta): mantém o plano dela.
                "$setOnInsert": {
                    "user_id": user["_id"],
                    "status": "manual" if user.get("plan_id", FREE_PLAN_ID) != FREE_PLAN_ID else "expired",
                    "plan_id": user.get("plan_id") or FREE_PLAN_ID,
                    "manual_until": None,
                    "created_at": _now(),
                },
            },
            upsert=True,
        )

    old = (sub.get("checkout") or {}).get("asaas_subscription_id")
    if old:
        with contextlib.suppress(asaas.AsaasError):
            await asaas.cancel_subscription(old)

    free_first = first == 0  # cupom de 100% só na primeira: a primeira cobrança é no próximo ciclo
    next_due = add_cycle(today_br(), cycle) if free_first else today_br()
    remote = await asaas.create_subscription(
        customer_id,
        value_cents=value,
        cycle=cycle,
        billing_type=billing_type,
        next_due=next_due,
        description=f"Clipo {plan.name} ({'anual' if cycle == 'yearly' else 'mensal'})",
        external_id=user["_id"],
    )
    if coupon and not await _redeem(db, coupon, user["_id"]):
        await asaas.cancel_subscription(remote["id"])
        raise BillingError("invalid_coupon", "Cupom esgotado.", 409)

    coupon_info = (
        {
            "code": coupon["_id"],
            "kind": coupon["kind"],
            "value": coupon["value"],
            "duration": coupon["duration"],
        }
        if coupon
        else None
    )
    if free_first:
        sub = await _save(
            db,
            user["_id"],
            {
                "status": "active",
                "plan_id": plan.id,
                "cycle": cycle,
                "asaas_subscription_id": remote["id"],
                "current_period_end": end_of_day(next_due),
                "cancel_at_period_end": False,
                "coupon": coupon_info,
                "checkout": None,
            },
            "activated",
            f"Plano {plan.name} ativado com cupom de 100% na primeira cobrança",
            unset=("trial_ends_at", "grace_ends_at", "pending_plan_id", "pending_cycle", "pending_from"),
            details={"coupon": coupon["_id"]},
        )
        return {"invoice_url": None, "subscription": sub}

    payments = await asaas.subscription_payments(remote["id"])
    pay = payments[0] if payments else {}
    if coupon_info and coupon_info["duration"] == "once" and pay.get("id") and first != value:
        pay = {**pay, **await asaas.update_payment_value(pay["id"], first)}
    sub = await _save(
        db,
        user["_id"],
        {
            "checkout": {
                "plan_id": plan.id,
                "cycle": cycle,
                "billing_type": billing_type,
                "asaas_subscription_id": remote["id"],
                "payment_id": pay.get("id"),
                "invoice_url": pay.get("invoiceUrl"),
                "value_cents": value,
                "first_charge_cents": first,
                "coupon": coupon_info,
                "created_at": _now(),
            }
        },
        "checkout_opened",
        f"Checkout do plano {plan.name}: primeira cobrança de {_brl(first)}",
        details={"plan": plan.id, "cycle": cycle, "coupon": coupon_info and coupon_info["code"]},
    )
    await audit("billing.checkout", target_user_id=user["_id"], details={"plan": plan.id, "cycle": cycle})
    return {"invoice_url": pay.get("invoiceUrl"), "subscription": sub}


# ---------------------------------------------------------------- troca, cancelamento, retomada


async def change_plan(db: AsyncDatabase, user_id: str, plan_id: str, cycle: str) -> dict[str, Any]:
    sub = await get_subscription(db, user_id) or {}
    if sub.get("status") != "active" or not sub.get("asaas_subscription_id"):
        raise BillingError("no_subscription", "Você não tem uma assinatura ativa. Faça o checkout.", 409)
    if sub.get("cancel_at_period_end"):
        raise BillingError("cancel_scheduled", "A assinatura está cancelada. Retome antes de trocar.", 409)
    plan = await get_plan(db, plan_id)
    if plan.id != plan_id or not plan.public or not plan.active or plan.price_cents(cycle) <= 0:
        raise BillingError("plan_not_available", "Este plano não está à venda.")
    if plan.id == sub["plan_id"] and cycle == sub["cycle"]:
        return sub
    current = await get_plan(db, sub["plan_id"])
    coupon = sub.get("coupon") if (sub.get("coupon") or {}).get("duration") == "forever" else None
    value, _ = price_for(plan, cycle, coupon)
    await asaas.update_subscription(sub["asaas_subscription_id"], value_cents=value, cycle=cycle)
    upgrade = cycle == sub["cycle"] and plan.price_cents(cycle) > current.price_cents(cycle)
    if upgrade:
        # Sobe na hora; a próxima cobrança já vem no valor novo (sem cobrar a diferença do mês).
        return await _save(
            db,
            user_id,
            {"plan_id": plan.id},
            "upgraded",
            f"Plano trocado para {plan.name} na hora",
            unset=("pending_plan_id", "pending_cycle", "pending_from"),
            details={"from": current.id, "to": plan.id},
        )
    return await _save(
        db,
        user_id,
        {"pending_plan_id": plan.id, "pending_cycle": cycle, "pending_from": sub["current_period_end"]},
        "change_scheduled",
        f"Troca para {plan.name} agendada para o fim do período pago",
        details={"from": current.id, "to": plan.id, "cycle": cycle},
    )


async def cancel(db: AsyncDatabase, user_id: str) -> dict[str, Any]:
    sub = await get_subscription(db, user_id) or {}
    if sub.get("checkout"):
        with contextlib.suppress(asaas.AsaasError):
            await asaas.cancel_subscription(sub["checkout"]["asaas_subscription_id"])
        sub = await _save(db, user_id, {"checkout": None}, "checkout_cancelled", "Checkout desistido")
        if sub["status"] not in PAID_STATES:
            return sub
    if sub.get("status") == "past_due":
        return await expire(db, sub, "cancelled")
    if sub.get("status") != "active" or sub.get("cancel_at_period_end"):
        raise BillingError("nothing_to_cancel", "Não há assinatura ativa para cancelar.", 409)
    # Para as cobranças já; o plano continua até o fim do que foi pago.
    await asaas.cancel_subscription(sub["asaas_subscription_id"])
    sub = await _save(
        db,
        user_id,
        {
            "cancel_at_period_end": True,
            "asaas_subscription_id": None,
            "cancelled_remote_id": sub["asaas_subscription_id"],
        },
        "cancel_scheduled",
        "Assinatura cancelada: o plano vale até o fim do período pago",
        unset=("pending_plan_id", "pending_cycle", "pending_from"),
        details={"until": sub["current_period_end"].isoformat()},
    )
    await audit(
        "billing.cancel", target_user_id=user_id, details={"until": sub["current_period_end"].isoformat()}
    )
    until = sub["current_period_end"].astimezone(BR)
    await _notify(
        db,
        user_id,
        "Assinatura cancelada",
        f"Você continua com o plano até {until:%d/%m/%Y}. Depois disso a conta passa para o plano gratuito.",
        f"cancel:{user_id}:{sub['current_period_end']:%Y%m%d}",
    )
    return sub


async def resume(db: AsyncDatabase, user_id: str) -> dict[str, Any]:
    """Desfaz o cancelamento antes do fim do período: a cobrança volta no próximo vencimento."""
    sub = await get_subscription(db, user_id) or {}
    if (
        sub.get("status") != "active"
        or not sub.get("cancel_at_period_end")
        or sub["current_period_end"] <= _now()
    ):
        raise BillingError("nothing_to_resume", "Não há cancelamento para desfazer.", 409)
    plan = await get_plan(db, sub["plan_id"])
    coupon = sub.get("coupon") if (sub.get("coupon") or {}).get("duration") == "forever" else None
    value, _ = price_for(plan, sub["cycle"], coupon)
    remote = await asaas.create_subscription(
        sub["asaas_customer_id"],
        value_cents=value,
        cycle=sub["cycle"],
        billing_type="UNDEFINED",
        next_due=sub["current_period_end"].astimezone(BR).date(),
        description=f"Clipo {plan.name} ({'anual' if sub['cycle'] == 'yearly' else 'mensal'})",
        external_id=user_id,
    )
    return await _save(
        db,
        user_id,
        {"cancel_at_period_end": False, "asaas_subscription_id": remote["id"]},
        "resumed",
        "Cancelamento desfeito",
    )


async def expire(db: AsyncDatabase, sub: dict[str, Any], reason: str) -> dict[str, Any]:
    """Volta para o plano gratuito e para qualquer cobrança futura."""
    remote = sub.get("asaas_subscription_id")
    if remote:
        try:
            await asaas.cancel_subscription(remote)
        except asaas.AsaasError as exc:
            await record(
                "payment",
                "subscription.remote_cancel_failed",
                exc.message,
                level="error",
                outcome="failure",
                user_id=sub["_id"],
                details={"asaas_subscription_id": remote},
            )
    messages = {
        "trial_ended": (
            "Seu teste grátis acabou",
            "A conta passou para o plano gratuito. Assine para voltar a ter os limites do plano.",
        ),
        "overdue": (
            "Plano rebaixado por falta de pagamento",
            "O prazo para pagar a cobrança atrasada acabou e a conta passou para o plano gratuito.",
        ),
        "cancelled": (
            "Assinatura encerrada",
            "O período pago acabou e a conta passou para o plano gratuito.",
        ),
        "refunded": (
            "Pagamento reembolsado",
            "O pagamento do período foi devolvido e a conta passou para o plano gratuito.",
        ),
        "manual_ended": ("Plano cortesia encerrado", "A conta passou para o plano gratuito."),
    }
    title, body = messages[reason]
    done = await _save(
        db,
        sub["_id"],
        {
            "status": "expired",
            "plan_id": FREE_PLAN_ID,
            "asaas_subscription_id": None,
            "cancel_at_period_end": False,
        },
        "expired",
        f"{title} ({reason})",
        unset=("grace_ends_at", "pending_plan_id", "pending_cycle", "pending_from", "manual_until"),
        details={"reason": reason, "previous_plan": sub.get("plan_id")},
    )
    await _notify(db, sub["_id"], title, body, f"expired:{sub['_id']}:{reason}:{_now():%Y%m%d}")
    return done


async def grant_manual(
    db: AsyncDatabase, user_id: str, plan_id: str, until: datetime | None, actor_id: str
) -> dict[str, Any]:
    sub = await get_subscription(db, user_id) or {}
    if sub.get("status") in PAID_STATES and sub.get("asaas_subscription_id"):
        raise BillingError("has_paid_subscription", "A pessoa tem assinatura paga. Cancele antes.", 409)
    plan = await get_plan(db, plan_id)
    if plan.id != plan_id:
        raise BillingError("plan_not_found", "Plano não encontrado.", 404)
    done = await _save(
        db,
        user_id,
        {"status": "manual", "plan_id": plan.id, "manual_until": until, "granted_by": actor_id},
        "manual_granted",
        f"Plano {plan.name} dado pelo admin",
        unset=("trial_ends_at", "grace_ends_at"),
        details={"until": until.isoformat() if until else None},
    )
    await audit("billing.manual_grant", target_user_id=user_id, details={"plan": plan.id})
    return done


# ---------------------------------------------------------------- webhook do Asaas


async def _seen(db: AsyncDatabase, event_id: str) -> bool:
    return await db.webhook_events.find_one({"_id": f"asaas:{event_id}"}, projection={"_id": 1}) is not None


async def _mark_seen(db: AsyncDatabase, event_id: str) -> None:
    with contextlib.suppress(DuplicateKeyError):
        await db.webhook_events.insert_one(
            {"_id": f"asaas:{event_id}", "received_at": _now(), "expires_at": _now() + timedelta(days=60)}
        )


def _cents(value: Any) -> int:
    return round(float(value or 0) * 100)


async def handle_event(db: AsyncDatabase, payload: dict[str, Any]) -> str:
    """Processa um evento do Asaas. Devolve o que foi feito (vai para o log e para a resposta)."""
    event = str(payload.get("event") or "")
    payment = payload.get("payment") or {}
    remote_sub = payload.get("subscription") or {}
    event_id = str(
        payload.get("id") or f"{event}:{payment.get('id') or remote_sub.get('id')}:{payment.get('status')}"
    )
    if await _seen(db, event_id):
        return "duplicate"
    outcome = await _dispatch(db, event, payment, remote_sub)
    await _mark_seen(db, event_id)
    return outcome


async def _dispatch(
    db: AsyncDatabase, event: str, payment: dict[str, Any], remote_sub: dict[str, Any]
) -> str:
    if event.startswith("SUBSCRIPTION_"):
        sub_id = remote_sub.get("id")
        sub = await db.subscriptions.find_one({"asaas_subscription_id": sub_id}) if sub_id else None
        if (
            sub
            and event in ("SUBSCRIPTION_DELETED", "SUBSCRIPTION_INACTIVATED")
            and sub["status"] == "active"
        ):
            # Cancelada fora do Clipo (painel do Asaas): vale até o fim do período pago.
            await _save(
                db,
                sub["_id"],
                {"cancel_at_period_end": True, "asaas_subscription_id": None},
                "cancel_scheduled",
                "Assinatura cancelada no Asaas: o plano vale até o fim do período",
            )
            return "cancel_scheduled"
        return "ignored"

    if not event.startswith("PAYMENT_") or not payment.get("id"):
        return "ignored"
    sub_id = payment.get("subscription")
    sub = (
        await db.subscriptions.find_one(
            {
                "$or": [
                    {"asaas_subscription_id": sub_id},
                    {"checkout.asaas_subscription_id": sub_id},
                    {"cancelled_remote_id": sub_id},
                ]
            }
        )
        if sub_id
        else None
    )
    if sub is None:
        await record(
            "payment",
            "webhook.unknown_subscription",
            f"Cobrança {payment['id']} sem assinatura conhecida",
            level="error",
            outcome="failure",
            details={"event": event, "subscription": sub_id},
        )
        return "unknown_subscription"

    user_id = sub["_id"]
    now = _now()
    await db.payments.update_one(
        {"_id": payment["id"]},
        {
            "$set": {
                "user_id": user_id,
                "asaas_subscription_id": sub_id,
                "value_cents": _cents(payment.get("value")),
                "net_cents": _cents(payment.get("netValue")),
                "billing_type": payment.get("billingType"),
                "status": payment.get("status"),
                "due_date": payment.get("dueDate"),
                "invoice_url": payment.get("invoiceUrl"),
                "updated_at": now,
            },
            "$setOnInsert": {"created_at": now, "applied_at": None},
        },
        upsert=True,
    )

    if event in ("PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"):
        # CONFIRMED (cartão aprovado) e RECEIVED (dinheiro caiu) chegam os dois: aplica só uma vez.
        claimed = await db.payments.find_one_and_update(
            {"_id": payment["id"], "applied_at": None}, {"$set": {"applied_at": now}}
        )
        if claimed is None:
            return "already_applied"
        return await _paid(db, sub, payment)

    if event == "PAYMENT_OVERDUE":
        if sub.get("asaas_subscription_id") == sub_id and sub["status"] == "active":
            grace = now + timedelta(days=get_settings().billing_grace_days)
            await _save(
                db,
                user_id,
                {"status": "past_due", "grace_ends_at": grace},
                "past_due",
                "Cobrança atrasada: plano mantido até o fim do prazo de tolerância",
                details={"payment_id": payment["id"], "grace_ends_at": grace.isoformat()},
            )
            await _notify(
                db,
                user_id,
                "Pagamento atrasado",
                f"A cobrança de {_brl(_cents(payment.get('value')))} venceu. Pague até "
                f"{grace.astimezone(BR):%d/%m/%Y} para não perder o plano.",
                f"overdue:{payment['id']}",
            )
            return "past_due"
        return "overdue_checkout"

    if event in ("PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED", "PAYMENT_CHARGEBACK_DISPUTE"):
        stored = await db.payments.find_one_and_update(
            {"_id": payment["id"]}, {"$set": {"refunded_at": now}}, return_document=ReturnDocument.AFTER
        )
        covers_now = stored.get("period_end") and sub.get("current_period_end") == stored["period_end"]
        if covers_now and sub["status"] in PAID_STATES:
            await expire(db, sub, "refunded")
            return "refunded_expired"
        return "refunded"

    return "recorded"


async def _paid(db: AsyncDatabase, sub: dict[str, Any], payment: dict[str, Any]) -> str:
    user_id, sub_id = sub["_id"], payment.get("subscription")
    checkout_ = sub.get("checkout") or {}
    is_checkout = checkout_.get("asaas_subscription_id") == sub_id
    cycle = checkout_.get("cycle") if is_checkout else sub.get("cycle", "monthly")
    due = date.fromisoformat(payment.get("dueDate") or today_br().isoformat())
    period_end = end_of_day(add_cycle(due, cycle))
    await db.payments.update_one({"_id": payment["id"]}, {"$set": {"period_end": period_end}})
    value = _brl(_cents(payment.get("value")))

    if is_checkout:
        plan = await get_plan(db, checkout_["plan_id"])
        await _save(
            db,
            user_id,
            {
                "status": "active",
                "plan_id": plan.id,
                "cycle": cycle,
                "asaas_subscription_id": sub_id,
                "current_period_end": period_end,
                "cancel_at_period_end": False,
                "coupon": checkout_.get("coupon"),
                "checkout": None,
            },
            "activated",
            f"Pagamento confirmado: plano {plan.name} ativo",
            unset=(
                "trial_ends_at",
                "grace_ends_at",
                "pending_plan_id",
                "pending_cycle",
                "pending_from",
                "manual_until",
            ),
            details={"payment_id": payment["id"], "period_end": period_end.isoformat()},
        )
        await _notify(
            db,
            user_id,
            f"Plano {plan.name} ativado",
            f"Recebemos o pagamento de {value}. O plano vale até {period_end.astimezone(BR):%d/%m/%Y}.",
            f"paid:{payment['id']}",
        )
        return "activated"

    # Renovação (ou pagamento atrasado que chegou dentro do prazo de tolerância).
    if sub["status"] not in PAID_STATES:
        await record(
            "payment",
            "webhook.late_payment",
            f"Pagamento {payment['id']} chegou com a assinatura {sub['status']}",
            level="warning",
            user_id=user_id,
            details={"payment_id": payment["id"]},
        )
        return "late_payment"
    end = max(period_end, sub.get("current_period_end") or period_end)
    await _save(
        db,
        user_id,
        {"status": "active", "current_period_end": end},
        "renewed",
        f"Renovação paga ({value})",
        unset=("grace_ends_at",),
        details={"payment_id": payment["id"], "period_end": end.isoformat()},
    )
    await _notify(
        db,
        user_id,
        "Pagamento confirmado",
        f"Recebemos {value}. O plano vale até {end.astimezone(BR):%d/%m/%Y}.",
        f"paid:{payment['id']}",
    )
    return "renewed"


async def refund(db: AsyncDatabase, payment_id: str, actor_id: str) -> dict[str, Any]:
    payment = await db.payments.find_one({"_id": payment_id})
    if payment is None:
        raise BillingError("not_found", "Cobrança não encontrada.", 404)
    if payment.get("refunded_at"):
        raise BillingError("already_refunded", "Esta cobrança já foi reembolsada.", 409)
    result = await asaas.refund_payment(payment_id)
    await audit("billing.refund", target_user_id=payment["user_id"], details={"payment_id": payment_id})
    await record(
        "payment",
        "payment.refund_requested",
        f"Reembolso pedido ao Asaas: {payment_id}",
        outcome="success",
        user_id=payment["user_id"],
        details={"by": actor_id},
    )
    # O plano só muda quando o webhook PAYMENT_REFUNDED chegar.
    return {"payment_id": payment_id, "status": result.get("status", "REFUND_REQUESTED")}


# ---------------------------------------------------------------- rotina do worker


async def sweep(db: AsyncDatabase) -> int:
    """Fim do teste, fim do prazo de tolerância, fim do período cancelado e trocas agendadas."""
    now = _now()
    count = 0
    async for sub in db.subscriptions.find({"status": "trialing", "trial_ends_at": {"$lte": now}}):
        await expire(db, sub, "trial_ended")
        count += 1
    soon = now + timedelta(days=2)
    async for sub in db.subscriptions.find(
        {"status": "trialing", "trial_ends_at": {"$gt": now, "$lte": soon}}
    ):
        plan = await get_plan(db, sub["plan_id"])
        await _notify(
            db,
            sub["_id"],
            "Seu teste grátis acaba em breve",
            f"O teste do plano {plan.name} acaba em {sub['trial_ends_at'].astimezone(BR):%d/%m/%Y}. "
            "Assine para não perder os limites do plano.",
            f"trial-ending:{sub['_id']}",
        )
    async for sub in db.subscriptions.find({"status": "past_due", "grace_ends_at": {"$lte": now}}):
        await expire(db, sub, "overdue")
        count += 1
    async for sub in db.subscriptions.find(
        {"status": "active", "cancel_at_period_end": True, "current_period_end": {"$lte": now}}
    ):
        await expire(db, sub, "cancelled")
        count += 1
    async for sub in db.subscriptions.find({"status": "active", "pending_from": {"$lte": now}}):
        plan = await get_plan(db, sub["pending_plan_id"])
        await _save(
            db,
            sub["_id"],
            {"plan_id": plan.id, "cycle": sub["pending_cycle"]},
            "downgraded",
            f"Troca agendada aplicada: plano {plan.name}",
            unset=("pending_plan_id", "pending_cycle", "pending_from"),
        )
        count += 1
    # Rede de segurança: período vencido sem webhook de atraso (o Asaas avisa no dia seguinte).
    late = now - timedelta(days=2)
    async for sub in db.subscriptions.find(
        {"status": "active", "cancel_at_period_end": {"$ne": True}, "current_period_end": {"$lte": late}}
    ):
        grace = now + timedelta(days=get_settings().billing_grace_days)
        await _save(
            db,
            sub["_id"],
            {"status": "past_due", "grace_ends_at": grace},
            "past_due",
            "Período vencido sem confirmação de pagamento",
            details={"grace_ends_at": grace.isoformat()},
        )
        count += 1
    async for sub in db.subscriptions.find({"status": "manual", "manual_until": {"$ne": None, "$lte": now}}):
        await expire(db, sub, "manual_ended")
        count += 1
    return count


# ---------------------------------------------------------------- saída para a tela


def public_subscription(sub: dict[str, Any] | None, user_plan_id: str) -> dict[str, Any]:
    def iso(v: Any) -> str | None:
        return v.isoformat() if isinstance(v, datetime) else None

    if sub is None:
        return {
            "status": "manual" if user_plan_id != FREE_PLAN_ID else "expired",
            "plan_id": user_plan_id,
            "effective_plan_id": user_plan_id,
            "cycle": None,
            "checkout": None,
        }
    checkout_ = sub.get("checkout")
    return {
        "status": sub["status"],
        "plan_id": sub.get("plan_id"),
        "effective_plan_id": effective_plan_id(sub),
        "cycle": sub.get("cycle"),
        "trial_ends_at": iso(sub.get("trial_ends_at")),
        "current_period_end": iso(sub.get("current_period_end")),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
        "grace_ends_at": iso(sub.get("grace_ends_at")),
        "pending_plan_id": sub.get("pending_plan_id"),
        "pending_cycle": sub.get("pending_cycle"),
        "pending_from": iso(sub.get("pending_from")),
        "manual_until": iso(sub.get("manual_until")),
        "coupon": sub.get("coupon"),
        "document_last4": sub.get("document_last4"),
        "checkout": {
            "plan_id": checkout_["plan_id"],
            "cycle": checkout_["cycle"],
            "invoice_url": checkout_.get("invoice_url"),
            "first_charge_cents": checkout_.get("first_charge_cents"),
            "value_cents": checkout_.get("value_cents"),
            "created_at": iso(checkout_.get("created_at")),
        }
        if checkout_
        else None,
    }

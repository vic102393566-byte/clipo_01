"""Gateway de IA com LangChain: uma porta só para Gemini, Claude, OpenAI e modelo local.

Para cada tarefa:
1. confere o teto de gasto do dia;
2. escolhe a versão do prompt (teste A/B);
3. tenta os modelos da fila em ordem; se um falha (erro, tempo esgotado ou resposta fora do formato),
   vai para o próximo;
4. valida a resposta com o modelo Pydantic da tarefa;
5. grava a chamada em `ai_calls` e no log do sistema com modelo, tokens, custo, tempo e tentativas.
"""

import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import status
from pydantic import BaseModel
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.errors import ApiError
from clipo_api.observability.logs import record
from clipo_api.services import settings as settings_service
from clipo_api.services.ai import config, credits, prompts

CALL_TIMEOUT_SECONDS = 120


class AIUnavailable(ApiError):
    def __init__(self, message: str = "A IA não está configurada no servidor."):
        super().__init__(status.HTTP_503_SERVICE_UNAVAILABLE, "ai_unavailable", message)


class AIFailed(ApiError):
    def __init__(self, message: str = "A IA não respondeu agora. Tente de novo em instantes."):
        super().__init__(status.HTTP_502_BAD_GATEWAY, "ai_failed", message)


@dataclass
class Result:
    data: Any
    call_id: str
    provider: str
    model: str
    prompt_id: str
    cost_usd: float | None


def chat_model(provider: str, model: str, temperature: float) -> Any:
    """Cria o modelo do LangChain. Import só aqui: subir a API não carrega os quatro SDKs."""
    key = config.key_for(provider)
    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI

        return ChatGoogleGenerativeAI(model=model, google_api_key=key, temperature=temperature)
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model=model, api_key=key, temperature=temperature, max_tokens=4096)
    if provider == "openai":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(model=model, api_key=key, temperature=temperature)
    if provider == "local":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(model=model, base_url=key, api_key="local", temperature=temperature)
    raise ValueError(f"provedor desconhecido: {provider}")


CREATIVE_TASKS = ("ideas", "script", "script_edit", "metadata")


async def invoke_model(
    provider: str, model: str, messages: list[tuple[str, str]], schema: type[BaseModel], temperature: float
) -> tuple[BaseModel, dict[str, int]]:
    """Uma chamada a um modelo. Os testes trocam esta função para simular os provedores."""
    runnable = chat_model(provider, model, temperature).with_structured_output(schema, include_raw=True)
    result = await runnable.ainvoke(messages)
    if result.get("parsing_error") or result.get("parsed") is None:
        raise ValueError(f"resposta fora do formato: {result.get('parsing_error')}")
    parsed = result["parsed"]
    if not isinstance(parsed, schema):
        parsed = schema.model_validate(parsed)
    usage = getattr(result.get("raw"), "usage_metadata", None) or {}
    return parsed, {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
    }


class BudgetExceeded(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "ai_budget_exceeded",
            "A IA atingiu o limite de uso de hoje. Tente de novo amanhã.",
        )


async def check_budget(db: AsyncDatabase, task: str, user_id: str) -> float:
    """Levanta BudgetExceeded se o teto do dia já foi atingido. Devolve o teto."""
    conf = await config.load(db)
    spent, budget = await credits.spent_today(db), conf["daily_budget_usd"]
    if spent >= budget:
        await record(
            "ai",
            "budget.exceeded",
            f"Teto diário de IA atingido (US$ {spent:.2f} de {budget:.2f})",
            level="error",
            outcome="denied",
            user_id=user_id,
            details={"task": task},
        )
        raise BudgetExceeded()
    return budget


async def run(
    db: AsyncDatabase,
    task: str,
    schema: type[BaseModel],
    variables: dict[str, Any],
    *,
    user_id: str,
    ref: dict[str, Any] | None = None,
) -> Result:
    conf = await config.load(db)
    models = config.available_models(conf, task)
    if not models:
        await record(
            "ai", f"{task}.unavailable", "Nenhum provedor de IA configurado", level="warning", user_id=user_id
        )
        raise AIUnavailable()
    budget = await check_budget(db, task, user_id)

    prompt = await prompts.pick(db, task, user_id)
    messages = [("system", prompt.system), ("human", prompt.render(variables))]
    temperature = float(conf["tasks"][task].get("temperature", 0.5))
    prefs = (await settings_service.workspace(db, user_id))["ai"] if user_id else {}
    if prefs.get("provider") not in (None, "auto"):
        # Preferência do workspace: o provedor escolhido vai para o começo (os outros seguem de reserva).
        models = sorted(models, key=lambda m: m[0] != prefs["provider"])
    if prefs.get("creativity") is not None and task in CREATIVE_TASKS:
        temperature = float(prefs["creativity"])
    attempts: list[dict[str, Any]] = []
    started_all = time.perf_counter()
    for provider, model in models:
        started = time.perf_counter()
        try:
            data, usage = await asyncio.wait_for(
                invoke_model(provider, model, messages, schema, temperature), CALL_TIMEOUT_SECONDS
            )
        except Exception as exc:  # qualquer falha do provedor: tenta o próximo da fila
            attempts.append(
                {
                    "provider": provider,
                    "model": model,
                    "error": f"{type(exc).__name__}: {str(exc)[:200]}",
                    "ms": round((time.perf_counter() - started) * 1000),
                }
            )
            await record(
                "ai",
                f"{task}.attempt_failed",
                f"{provider}:{model} falhou: {type(exc).__name__}",
                level="warning",
                outcome="failure",
                platform=provider,
                user_id=user_id,
                duration_ms=(time.perf_counter() - started) * 1000,
                details={"model": model, "error": str(exc)[:300], "prompt": prompt.id},
            )
            continue
        cost = config.cost_usd(conf, provider, model, usage["input_tokens"], usage["output_tokens"])
        call_id = uuid4().hex
        ms = round((time.perf_counter() - started) * 1000)
        await db.ai_calls.insert_one(
            {
                "_id": call_id,
                "task": task,
                "user_id": user_id,
                "provider": provider,
                "model": model,
                "prompt_id": prompt.id,
                "prompt_version": prompt.version,
                "input_tokens": usage["input_tokens"],
                "output_tokens": usage["output_tokens"],
                "cost_usd": cost,
                "ms": ms,
                "status": "ok",
                "fallbacks": attempts,
                "ref": ref or {},
                "feedback": None,
                "created_at": datetime.now(UTC),
            }
        )
        await credits.add_spend(db, cost, budget)
        await record(
            "ai",
            f"{task}.generated",
            f"{task} com {provider}:{model} — {usage['input_tokens']}+{usage['output_tokens']} tokens, "
            + (f"US$ {cost:.6f}" if cost is not None else "sem preço configurado"),
            outcome="success",
            platform=provider,
            user_id=user_id,
            duration_ms=(time.perf_counter() - started_all) * 1000,
            details={
                "call_id": call_id,
                "model": model,
                "prompt": prompt.id,
                "input_tokens": usage["input_tokens"],
                "output_tokens": usage["output_tokens"],
                "cost_usd": cost,
                "fallbacks": len(attempts),
            },
        )
        return Result(data, call_id, provider, model, prompt.id, cost)

    await db.ai_calls.insert_one(
        {
            "_id": uuid4().hex,
            "task": task,
            "user_id": user_id,
            "prompt_id": prompt.id,
            "status": "failed",
            "fallbacks": attempts,
            "ref": ref or {},
            "cost_usd": None,
            "created_at": datetime.now(UTC),
        }
    )
    await record(
        "ai",
        f"{task}.failed",
        f"Todos os modelos falharam ({len(attempts)})",
        level="error",
        outcome="failure",
        user_id=user_id,
        details={"attempts": attempts, "prompt": prompt.id},
    )
    raise AIFailed()


async def log_external(
    db: AsyncDatabase,
    task: str,
    *,
    user_id: str,
    provider: str,
    model: str,
    cost: float | None,
    ms: float,
    ref: dict[str, Any],
    units: dict[str, Any],
) -> str:
    """Chamada que não passa pelo LangChain (ex.: transcrição): mesmo registro e mesmo teto diário."""
    conf = await config.load(db)
    call_id = uuid4().hex
    await db.ai_calls.insert_one(
        {
            "_id": call_id,
            "task": task,
            "user_id": user_id,
            "provider": provider,
            "model": model,
            "cost_usd": cost,
            "ms": round(ms),
            "status": "ok",
            "ref": ref,
            "units": units,
            "created_at": datetime.now(UTC),
        }
    )
    await credits.add_spend(db, cost, conf["daily_budget_usd"])
    await record(
        "ai",
        f"{task}.generated",
        f"{task} com {provider}:{model} — "
        + (f"US$ {cost:.6f}" if cost is not None else "sem preço configurado"),
        outcome="success",
        platform=provider,
        user_id=user_id,
        duration_ms=ms,
        details={"call_id": call_id, "model": model, "cost_usd": cost, **units},
    )
    return call_id

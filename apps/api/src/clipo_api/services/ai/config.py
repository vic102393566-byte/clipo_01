"""Configuração da IA guardada no banco (o admin muda sem subir código).

- tasks: para cada tarefa, a fila de modelos em ordem ("provedor:modelo"); se um falha, vai o próximo.
- prices: preço de cada modelo em dólar (por milhão de tokens de entrada e de saída; transcrição
  por minuto). Modelo sem preço aparece no log com tokens e custo "sem preço"; local custa 0.
- credit_costs: quantos créditos do plano cada ação gasta.
- daily_budget_usd: teto de gasto por dia somando todas as contas. Passou, a IA paga para até virar o dia.
"""

import copy
import time
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.config import get_settings
from clipo_api.services import crypto

PROVIDERS = ("gemini", "anthropic", "openai", "local")
TASKS = ("metadata", "highlights", "ideas", "script", "script_edit")
CACHE_SECONDS = 30

DEFAULTS: dict[str, Any] = {
    "tasks": {
        "metadata": {
            "models": [
                "gemini:gemini-flash-latest",
                "anthropic:claude-haiku-5-5",
                "openai:gpt-4o-mini",
                "local:default",
            ],
            "temperature": 0.7,
        },
        "highlights": {
            "models": [
                "gemini:gemini-flash-latest",
                "anthropic:claude-sonnet-5-5",
                "openai:gpt-4o",
                "local:default",
            ],
            "temperature": 0.3,
        },
        "ideas": {
            "models": [
                "gemini:gemini-flash-latest",
                "anthropic:claude-haiku-5-5",
                "openai:gpt-4o-mini",
                "local:default",
            ],
            "temperature": 0.9,
        },
        "script": {
            "models": [
                "gemini:gemini-flash-latest",
                "anthropic:claude-sonnet-5-5",
                "openai:gpt-4o",
                "local:default",
            ],
            "temperature": 0.7,
        },
        "script_edit": {
            "models": [
                "gemini:gemini-flash-latest",
                "anthropic:claude-haiku-5-5",
                "openai:gpt-4o-mini",
                "local:default",
            ],
            "temperature": 0.6,
        },
    },
    "prices": {},
    "credit_costs": {
        "metadata": 1,
        "highlights": 5,
        "transcription_per_minute": 1,
        "subtitles_burn": 2,
        "ideas": 1,
        "script": 2,
        "script_edit": 1,
    },
    "daily_budget_usd": 20.0,
}

_cache: dict[str, Any] | None = None
_loaded_at = 0.0


def invalidate() -> None:
    global _loaded_at
    _loaded_at = 0.0


async def load(db: AsyncDatabase) -> dict[str, Any]:
    global _cache, _loaded_at
    if _cache is None or time.monotonic() - _loaded_at > CACHE_SECONDS:
        doc = await db.ai_settings.find_one({"_id": "default"}) or {}
        merged = copy.deepcopy(DEFAULTS)
        for key in ("prices", "credit_costs"):
            merged[key].update(doc.get(key) or {})
        for task, conf in (doc.get("tasks") or {}).items():
            merged["tasks"][task] = {**merged["tasks"].get(task, {}), **conf}
        if doc.get("daily_budget_usd") is not None:
            merged["daily_budget_usd"] = float(doc["daily_budget_usd"])
        # Chaves cadastradas pelo admin (criptografadas no banco) valem por cima das do .env.
        merged["keys"] = {}
        for provider, sealed in (doc.get("keys") or {}).items():
            try:
                merged["keys"][provider] = crypto.decrypt(sealed)["key"]
            except crypto.InvalidToken:
                continue
        _cache, _loaded_at = merged, time.monotonic()
    return _cache


def key_for(provider: str, conf: dict[str, Any] | None = None) -> str | None:
    """Chave (ou, no local, a URL) do provedor: a do admin, se houver; senão a do .env."""
    conf = conf if conf is not None else (_cache or {})
    if (conf.get("keys") or {}).get(provider):
        return conf["keys"][provider]
    s = get_settings()
    return {
        "gemini": s.gemini_api_key,
        "anthropic": s.anthropic_api_key,
        "openai": s.openai_api_key,
        "local": s.local_llm_url,
    }.get(provider)


def key_source(provider: str, conf: dict[str, Any]) -> str | None:
    if (conf.get("keys") or {}).get(provider):
        return "admin"
    return "env" if key_for(provider, {}) else None


def provider_ready(provider: str, conf: dict[str, Any] | None = None) -> bool:
    return bool(key_for(provider, conf))


def resolve(spec: str) -> tuple[str, str]:
    provider, _, model = spec.partition(":")
    if provider == "local" and model in ("", "default"):
        model = get_settings().local_llm_model
    return provider, model


def available_models(conf: dict[str, Any], task: str) -> list[tuple[str, str]]:
    return [resolve(m) for m in conf["tasks"][task]["models"] if provider_ready(resolve(m)[0], conf)]


def cost_usd(
    conf: dict[str, Any], provider: str, model: str, input_tokens: int, output_tokens: int
) -> float | None:
    if provider == "local":
        return 0.0
    price = conf["prices"].get(f"{provider}:{model}")
    if not price or price.get("input_per_mtok") is None or price.get("output_per_mtok") is None:
        return None
    return round((input_tokens * price["input_per_mtok"] + output_tokens * price["output_per_mtok"]) / 1e6, 6)


def stt_cost_usd(conf: dict[str, Any], provider: str, model: str, minutes: float) -> float | None:
    if provider == "local":
        return 0.0
    price = conf["prices"].get(f"stt:{provider}:{model}")
    if not price or price.get("per_minute") is None:
        return None
    return round(minutes * price["per_minute"], 6)

"""IA para criar: ideias de vídeo, roteiro falado e ajustes no roteiro."""

import json
from typing import Annotated, Any, Literal

from fastapi import status
from pydantic import BaseModel, Field
from pymongo.asynchronous.database import AsyncDatabase

from clipo_api.core.errors import ApiError
from clipo_api.services.ai import config as ai_config
from clipo_api.services.ai import credits, gateway


class IdeaOut(BaseModel):
    title: Annotated[str, Field(description="A promessa do vídeo.")]
    hook: Annotated[str, Field(description="Primeira frase falada.")]
    category: Literal["viral", "conversion", "educational"]
    bullets: Annotated[list[str], Field(description="3 pontos do roteiro.")]
    cta: Annotated[str, Field(description="Chamada para ação.")]
    duration_s: Annotated[int, Field(ge=10, le=180)]
    effort: Literal["low", "medium", "high"]
    score: Annotated[int, Field(ge=0, le=100)]
    score_reason: str
    platforms: list[Literal["tiktok", "instagram", "youtube", "linkedin"]]


class IdeasOut(BaseModel):
    ideas: list[IdeaOut]


class BlockOut(BaseModel):
    act: str
    speech: str
    visual: str
    emphasis: str = ""
    pacing_note: str = ""


class ScriptOut(BaseModel):
    blocks: list[BlockOut]
    retention_score: Annotated[int, Field(ge=0, le=100)]


async def paid(
    db: AsyncDatabase, user_id: str, task: str, label: str, call: Any
) -> tuple[Any, dict[str, Any]]:
    """Confere a IA, cobra os créditos da tarefa e devolve se a chamada falhar."""
    conf = await ai_config.load(db)
    if not ai_config.available_models(conf, task):
        raise ApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE, "ai_unavailable", "A IA não está configurada no servidor."
        )
    amount = await credits.reserve(db, user_id, int(conf["credit_costs"].get(task, 1)), label)
    try:
        result = await call()
    except Exception:
        await credits.refund(db, user_id, amount)
        raise
    return result, await credits.usage(db, user_id)


async def ideas(
    db: AsyncDatabase,
    user_id: str,
    *,
    count: int,
    niche: str,
    prompt: str,
    tone: str,
    fmt: str,
    top: list[str],
    existing: list[str],
) -> tuple[list[IdeaOut], str]:
    result = await gateway.run(
        db,
        "ideas",
        IdeasOut,
        {
            "count": count,
            "niche": niche or "não informado",
            "prompt": prompt or "livre: escolha os temas com mais chance para este nicho",
            "tone": tone,
            "format": fmt,
            "top": "\n".join(top) or "(ainda sem dados de desempenho)",
            "existing": "\n".join(existing) or "(nenhuma)",
        },
        user_id=user_id,
        ref={"kind": "ideas"},
    )
    return result.data.ideas[:count], result.call_id


async def script(
    db: AsyncDatabase,
    user_id: str,
    *,
    title: str,
    hook: str,
    bullets: list[str],
    cta: str,
    niche: str,
    duration_s: int,
    wpm: int,
) -> tuple[ScriptOut, str]:
    result = await gateway.run(
        db,
        "script",
        ScriptOut,
        {
            "title": title,
            "hook": hook or "(crie um)",
            "bullets": "; ".join(bullets) or "(defina os melhores)",
            "cta": cta or "(crie uma)",
            "niche": niche or "não informado",
            "duration": duration_s,
            "wpm": wpm,
        },
        user_id=user_id,
        ref={"kind": "script"},
    )
    return result.data, result.call_id


INSTRUCTIONS = {
    "hook": "Reescreva só o primeiro bloco para um gancho mais forte nos 3 primeiros segundos.",
    "broll": "Reescreva só o campo visual de cada bloco com B-roll, texto na tela e efeitos sonoros.",
    "refine": "Deixe a fala mais natural e ritmada, corte palavras sobrando e ajuste à duração alvo.",
    "shorten": "Encurte a fala em cerca de 25% sem perder a ideia central.",
}


async def edit_script(
    db: AsyncDatabase,
    user_id: str,
    *,
    action: str,
    title: str,
    blocks: list[dict[str, Any]],
    duration_s: int,
    wpm: int,
) -> tuple[ScriptOut, str]:
    payload = [
        {k: b.get(k, "") for k in ("act", "speech", "visual", "emphasis", "pacing_note")} for b in blocks
    ]
    result = await gateway.run(
        db,
        "script_edit",
        ScriptOut,
        {
            "instruction": INSTRUCTIONS[action],
            "title": title,
            "duration": duration_s,
            "wpm": wpm,
            "blocks": json.dumps(payload, ensure_ascii=False),
        },
        user_id=user_id,
        ref={"kind": "script_edit", "action": action},
    )
    return result.data, result.call_id

"""Preferências: as do workspace (valem para toda a equipe) e as da pessoa.

Workspace (coleção `settings`, _id = dono):
- automation.enabled: desligado, o agendador não publica nada deste workspace (fica na fila).
- ai.provider: provedor preferido, vai para o começo da lista de modelos de cada tarefa.
- ai.creativity: temperatura das tarefas de criação (ideias e roteiros).
- ai.filter_profanity: palavrões viram asteriscos nas legendas gravadas.
- render.watermark: texto gravado no vídeo junto com as legendas.
- render.night_queue: cortes e divisões pedidos entre 7 h e 23 h esperam até 1 h da manhã.
- render.export: altura máxima, fps e qualidade dos cortes renderizados.
- privacy.trash_days: quanto tempo vídeo e corte ficam na lixeira.

Pessoa (`users.prefs`): visual do editor e IP estrito (sessão cai se o IP mudar).
"""

import copy
from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from pymongo.asynchronous.database import AsyncDatabase

WORKSPACE_DEFAULTS: dict[str, Any] = {
    "automation": {"enabled": True},
    "ai": {"provider": "auto", "creativity": None, "filter_profanity": False},
    "render": {
        "watermark": {"enabled": False, "text": "", "opacity": 35, "position": "top-right"},
        "night_queue": False,
        # max_height 0 = altura original; fps 0 = original. Qualidade: small, balanced, high.
        "export": {"max_height": 0, "fps": 0, "quality": "balanced"},
    },
    "privacy": {"trash_days": 7},
}
USER_DEFAULTS: dict[str, Any] = {
    "theme_preset": "clipo",
    "waveform": True,
    "timeline_snap": True,
    "glow": "medium",
    "strict_ip": False,
    "timezone": "America/Sao_Paulo",
}
NIGHT_TZ = ZoneInfo("America/Sao_Paulo")
NIGHT_START, NIGHT_END = time(1, 0), time(7, 0)


def _merge(base: dict[str, Any], stored: dict[str, Any] | None) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in (stored or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        elif key in out:
            out[key] = value
    return out


async def workspace(db: AsyncDatabase, workspace_id: str) -> dict[str, Any]:
    doc = await db.settings.find_one({"_id": workspace_id}) or {}
    return _merge(WORKSPACE_DEFAULTS, {k: v for k, v in doc.items() if k != "_id"})


async def update_workspace(db: AsyncDatabase, workspace_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    flat: dict[str, Any] = {}

    def walk(prefix: str, value: Any) -> None:
        if isinstance(value, dict):
            for k, v in value.items():
                walk(f"{prefix}.{k}" if prefix else k, v)
        else:
            flat[prefix] = value

    walk("", changes)
    if flat:
        await db.settings.update_one({"_id": workspace_id}, {"$set": flat}, upsert=True)
    return await workspace(db, workspace_id)


def user_prefs(user: dict[str, Any]) -> dict[str, Any]:
    return _merge(USER_DEFAULTS, user.get("prefs"))


async def paused_workspaces(db: AsyncDatabase) -> list[str]:
    return [d["_id"] async for d in db.settings.find({"automation.enabled": False}, projection={"_id": 1})]


def night_run_at(now: datetime | None = None) -> datetime | None:
    """Próximo horário da fila da madrugada, ou None se já é madrugada."""
    local = (now or datetime.now(UTC)).astimezone(NIGHT_TZ)
    if NIGHT_START <= local.time() < NIGHT_END:
        return None
    day = local.date() + (timedelta(days=1) if local.time() >= NIGHT_START else timedelta())
    return datetime.combine(day, NIGHT_START, tzinfo=NIGHT_TZ).astimezone(UTC)


PROFANITY = frozenset(
    {
        "porra",
        "caralho",
        "merda",
        "puta",
        "puto",
        "foda",
        "foder",
        "fodase",
        "cacete",
        "buceta",
        "bosta",
        "arrombado",
        "viado",
        "desgraça",
        "cuzão",
    }
)


def mask_profanity(word: str) -> str:
    core = word.strip(".,!?;:\"'()…").lower()
    if core in PROFANITY:
        return word.replace(word.strip(".,!?;:\"'()…"), core[0] + "*" * (len(core) - 1), 1)
    return word

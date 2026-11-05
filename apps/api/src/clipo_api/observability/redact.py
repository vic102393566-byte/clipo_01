"""Mascaramento: nenhum segredo entra no log, nem por engano.

Aplicado em todo `details` antes de gravar. Esconde por nome de campo (senha, token, cookie...)
e por formato do valor (cabeçalho Bearer, JWT, cartão, parâmetros de URL assinada).
"""

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

MASK = "[mascarado]"
MAX_DEPTH = 6
MAX_STRING = 2000
MAX_ITEMS = 50

_SECRET_KEY = re.compile(
    r"pass|senha|secret|token|authorization|cookie|api[_-]?key|apikey|signature|assinatura|"
    r"client[_-]?secret|code[_-]?verifier|private|credential|card|cartao|cvv|cvc|otp|session|"
    r"^code$|^state$|^nonce$|x-amz-",
    re.IGNORECASE,
)
_BEARER = re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b")
_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_EMAIL = re.compile(r"\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2:
            n = n * 2 - 9 if n > 4 else n * 2
        total += n
    return total % 10 == 0


def _mask_card(match: re.Match[str]) -> str:
    # Só números que passam no dígito verificador de cartão: timestamps e ids continuam legíveis.
    digits = re.sub(r"\D", "", match.group(0))
    return MASK if 13 <= len(digits) <= 19 and _luhn(digits) else match.group(0)


def mask_email(value: str) -> str:
    """ana.souza@example.com -> a***@example.com (dá para achar o caso sem expor o endereço)."""
    return _EMAIL.sub(lambda m: f"{m.group(1)}***@{m.group(2)}", value)


def redact_url(url: str) -> str:
    """Mantém host e caminho; esconde valores de parâmetros sensíveis (inclui URLs assinadas do S3)."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return MASK
    if not parts.query:
        return url
    query = [
        (k, MASK if _SECRET_KEY.search(k) else v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit(parts._replace(query=urlencode(query, safe="[]")))


def redact_text(value: str) -> str:
    value = _BEARER.sub(lambda m: f"{m.group(1)} {MASK}", value)
    value = _JWT.sub(MASK, value)
    value = _CARD.sub(_mask_card, value)
    value = mask_email(value)
    if value.startswith(("http://", "https://")):
        value = redact_url(value)
    return value[:MAX_STRING] + ("…" if len(value) > MAX_STRING else "")


def redact(value: Any, depth: int = 0) -> Any:
    if depth > MAX_DEPTH:
        return "[profundo demais]"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for i, (key, item) in enumerate(value.items()):
            if i >= MAX_ITEMS:
                out["…"] = f"{len(value) - MAX_ITEMS} campos omitidos"
                break
            out[str(key)] = MASK if _SECRET_KEY.search(str(key)) else redact(item, depth + 1)
        return out
    if isinstance(value, list | tuple):
        items = [redact(item, depth + 1) for item in list(value)[:MAX_ITEMS]]
        if len(value) > MAX_ITEMS:
            items.append(f"{len(value) - MAX_ITEMS} itens omitidos")
        return items
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, bytes):
        return f"[{len(value)} bytes]"
    if value is None or isinstance(value, bool | int | float):
        return value
    return redact_text(str(value))

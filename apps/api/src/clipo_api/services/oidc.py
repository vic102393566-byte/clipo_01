"""Entrar com Google e com Apple (OpenID Connect).

O que é conferido em cada login:
- `state`: de uso único, guardado no servidor por 10 min e preso ao navegador por um cookie;
- PKCE (Google): o código só vale junto com o segredo gerado no início do fluxo;
- `id_token`: assinatura pela chave pública do provedor, emissor, destinatário (nosso client id),
  validade e o `nonce` gerado no início;
- e-mail confirmado pelo provedor.
"""

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt

from clipo_api.core.config import get_settings
from clipo_api.observability.http import LoggedClient

STATE_TTL = timedelta(minutes=10)
JWKS_TTL_SECONDS = 3600
# Os testes trocam o transporte HTTP para simular os provedores sem rede.
HTTP_TRANSPORT: httpx.AsyncBaseTransport | None = None


class OidcError(Exception):
    """Falha no login social. `code` vai para a tela de login; `reason`, para o log."""

    def __init__(self, code: str, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class Provider:
    name: str
    label: str
    authorize_url: str
    token_url: str
    jwks_url: str
    issuers: tuple[str, ...]
    scope: str
    uses_pkce: bool
    form_post: bool


PROVIDERS: dict[str, Provider] = {
    "google": Provider(
        "google",
        "Google",
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token",
        "https://www.googleapis.com/oauth2/v3/certs",
        ("https://accounts.google.com", "accounts.google.com"),
        "openid email profile",
        uses_pkce=True,
        form_post=False,
    ),
    "apple": Provider(
        "apple",
        "Apple",
        "https://appleid.apple.com/auth/authorize",
        "https://appleid.apple.com/auth/token",
        "https://appleid.apple.com/auth/keys",
        ("https://appleid.apple.com",),
        "name email",
        uses_pkce=False,
        # A Apple só devolve nome e e-mail com response_mode=form_post (retorno por POST).
        form_post=True,
    ),
}


@dataclass(frozen=True)
class Identity:
    provider: str
    subject: str
    email: str
    name: str | None


def client_id(provider: str) -> str | None:
    s = get_settings()
    return {"google": s.google_client_id, "apple": s.apple_client_id}.get(provider)


def is_configured(provider: str) -> bool:
    s = get_settings()
    if provider == "google":
        return bool(s.google_client_id and s.google_client_secret)
    if provider == "apple":
        return bool(s.apple_client_id and s.apple_team_id and s.apple_key_id and s.apple_private_key)
    return False


def redirect_uri(provider: str) -> str:
    return f"{get_settings().app_base_url}/api/v1/auth/oauth/{provider}/callback"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    return verifier, _b64url(hashlib.sha256(verifier.encode()).digest())


def apple_client_secret() -> str:
    """A Apple não tem segredo fixo: é um JWT ES256 assinado com a chave .p8, válido por 5 min."""
    s = get_settings()
    now = int(time.time())
    key = (s.apple_private_key or "").replace("\\n", "\n")
    return jwt.encode(
        {
            "iss": s.apple_team_id,
            "iat": now,
            "exp": now + 300,
            "aud": "https://appleid.apple.com",
            "sub": s.apple_client_id,
        },
        key,
        algorithm="ES256",
        headers={"kid": s.apple_key_id},
    )


def _client(provider: str) -> LoggedClient:
    return LoggedClient(platform=provider, category="auth", transport=HTTP_TRANSPORT)


# Chaves públicas dos provedores, com cache: um login não baixa as chaves toda vez.
_jwks_cache: dict[str, tuple[float, dict[str, Any]]] = {}


async def _jwks(provider: Provider, *, refresh: bool = False) -> dict[str, Any]:
    cached = _jwks_cache.get(provider.name)
    if cached and not refresh and time.monotonic() - cached[0] < JWKS_TTL_SECONDS:
        return cached[1]
    async with _client(provider.name) as http:
        response = await http.get(provider.jwks_url)
    if response.status_code != 200:
        raise OidcError(
            "provider_unavailable", f"chaves de {provider.label} indisponíveis ({response.status_code})"
        )
    data = response.json()
    _jwks_cache[provider.name] = (time.monotonic(), data)
    return data


async def _signing_key(provider: Provider, token: str) -> Any:
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as exc:
        raise OidcError("invalid_token", "id_token malformado") from exc
    for attempt in (False, True):  # na segunda tentativa, o provedor pode ter trocado as chaves
        for jwk in (await _jwks(provider, refresh=attempt)).get("keys", []):
            if jwk.get("kid") == kid:
                return jwt.PyJWK(jwk).key
    raise OidcError("invalid_token", "chave do id_token desconhecida")


async def exchange_code(provider_name: str, code: str, verifier: str | None) -> dict[str, Any]:
    provider = PROVIDERS[provider_name]
    s = get_settings()
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(provider_name),
        "client_id": client_id(provider_name),
    }
    if provider_name == "google":
        form["client_secret"] = s.google_client_secret
    else:
        form["client_secret"] = apple_client_secret()
    if provider.uses_pkce and verifier:
        form["code_verifier"] = verifier
    async with _client(provider_name) as http:
        response = await http.post(provider.token_url, data=form, headers={"Accept": "application/json"})
    if response.status_code != 200:
        raise OidcError("exchange_failed", f"troca do código recusada ({response.status_code})")
    tokens = response.json()
    if not tokens.get("id_token"):
        raise OidcError("exchange_failed", "o provedor não devolveu id_token")
    return tokens


async def verify_id_token(provider_name: str, token: str, nonce: str) -> dict[str, Any]:
    provider = PROVIDERS[provider_name]
    key = await _signing_key(provider, token)
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256", "ES256"],
            audience=client_id(provider_name),
            issuer=list(provider.issuers),
            options={"require": ["iss", "aud", "exp", "iat", "sub"]},
            leeway=30,
        )
    except jwt.ExpiredSignatureError as exc:
        raise OidcError("invalid_token", "id_token vencido") from exc
    except jwt.InvalidAudienceError as exc:
        raise OidcError("invalid_token", "id_token emitido para outro aplicativo") from exc
    except jwt.InvalidIssuerError as exc:
        raise OidcError("invalid_token", "id_token de outro emissor") from exc
    except jwt.PyJWTError as exc:
        raise OidcError("invalid_token", f"id_token inválido: {type(exc).__name__}") from exc

    if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise OidcError("invalid_token", "nonce do id_token não confere")
    return claims


def identity_from_claims(
    provider_name: str, claims: dict[str, Any], apple_user: str | None = None
) -> Identity:
    email = str(claims.get("email") or "").strip().lower()
    # A Apple manda "true" como texto; o Google, como booleano.
    verified = str(claims.get("email_verified")).lower() == "true"
    if not email or not verified:
        raise OidcError("email_not_verified", "o provedor não confirmou o e-mail")
    name = claims.get("name")
    if provider_name == "apple" and apple_user:
        # Só no primeiro login a Apple manda o nome, num JSON fora do id_token.
        try:
            parsed = json.loads(apple_user).get("name") or {}
            name = " ".join(p for p in (parsed.get("firstName"), parsed.get("lastName")) if p) or None
        except (ValueError, AttributeError):
            name = None
    return Identity(provider_name, str(claims["sub"]), email, (name or "").strip()[:120] or None)


def new_state_doc(provider: str, next_path: str, binding: str) -> tuple[str, dict[str, Any]]:
    state = secrets.token_urlsafe(32)
    verifier, _ = pkce_pair()
    now = datetime.now(UTC)
    doc = {
        "_id": hashlib.sha256(state.encode()).hexdigest(),
        "provider": provider,
        "nonce": secrets.token_urlsafe(24),
        "verifier": verifier,
        "next": next_path,
        "binding": hashlib.sha256(binding.encode()).hexdigest(),
        "created_at": now,
        "expires_at": now + STATE_TTL,
    }
    return state, doc


def authorize_url(provider_name: str, state: str, doc: dict[str, Any]) -> str:
    from urllib.parse import urlencode

    provider = PROVIDERS[provider_name]
    params = {
        "client_id": client_id(provider_name),
        "redirect_uri": redirect_uri(provider_name),
        "response_type": "code",
        "scope": provider.scope,
        "state": state,
        "nonce": doc["nonce"],
    }
    if provider.uses_pkce:
        params["code_challenge"] = _b64url(hashlib.sha256(doc["verifier"].encode()).digest())
        params["code_challenge_method"] = "S256"
        params["prompt"] = "select_account"
    if provider.form_post:
        params["response_mode"] = "form_post"
    return f"{provider.authorize_url}?{urlencode(params)}"

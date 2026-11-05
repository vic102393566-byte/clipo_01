"""Entrar com Google e com Apple, com os provedores simulados (chaves geradas no teste)."""

import json
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from conftest import make_user
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from clipo_api.core.config import get_settings
from clipo_api.services import oidc

GOOGLE_ID = "google-client-teste.apps.googleusercontent.com"
APPLE_ID = "com.clipo.teste.web"

_rsa = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_ec = ec.generate_private_key(ec.SECP256R1())
_apple_signing = ec.generate_private_key(ec.SECP256R1())  # a chave .p8 da conta de desenvolvedor


def _pem(key) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()


def _jwk(key, kid: str, alg: str) -> dict:
    data = json.loads(jwt.algorithms.get_default_algorithms()[alg].to_jwk(key.public_key()))
    return {**data, "kid": kid, "alg": alg, "use": "sig"}


class FakeProviders:
    """Responde como os endpoints de token e de chaves do Google e da Apple."""

    def __init__(self):
        self.claims: dict = {}
        self.token_status = 200
        self.last_form: dict = {}

    def id_token(self, provider: str, nonce: str) -> str:
        now = int(time.time())
        base = {
            "google": {
                "iss": "https://accounts.google.com",
                "aud": GOOGLE_ID,
                "sub": "g-123",
                "email": "nova@example.com",
                "email_verified": True,
                "name": "Nova Pessoa",
            },
            "apple": {
                "iss": "https://appleid.apple.com",
                "aud": APPLE_ID,
                "sub": "a-456",
                "email": "abc123@privaterelay.appleid.com",
                "email_verified": "true",
            },
        }[provider]
        payload = {**base, "iat": now, "exp": now + 600, "nonce": nonce, **self.claims}
        if provider == "google":
            return jwt.encode(payload, _pem(_rsa), algorithm="RS256", headers={"kid": "g-key"})
        return jwt.encode(payload, _pem(_ec), algorithm="ES256", headers={"kid": "a-key"})

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == oidc.PROVIDERS["google"].jwks_url:
            return httpx.Response(200, json={"keys": [_jwk(_rsa, "g-key", "RS256")]})
        if url == oidc.PROVIDERS["apple"].jwks_url:
            return httpx.Response(200, json={"keys": [_jwk(_ec, "a-key", "ES256")]})
        form = dict(parse_qs(request.content.decode()))
        self.last_form = {k: v[0] for k, v in form.items()}
        provider = "google" if "googleapis" in url else "apple"
        if self.token_status != 200:
            return httpx.Response(self.token_status, json={"error": "invalid_grant"})
        nonce = self.last_form["code"].split(":", 1)[1]  # o teste põe o nonce no código
        return httpx.Response(200, json={"id_token": self.id_token(provider, nonce), "access_token": "at"})


@pytest.fixture
def providers(monkeypatch):
    fake = FakeProviders()
    monkeypatch.setenv("GOOGLE_CLIENT_ID", GOOGLE_ID)
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "segredo-google")
    monkeypatch.setenv("APPLE_CLIENT_ID", APPLE_ID)
    monkeypatch.setenv("APPLE_TEAM_ID", "TEAMID1234")
    monkeypatch.setenv("APPLE_KEY_ID", "KEYID12345")
    monkeypatch.setenv("APPLE_PRIVATE_KEY", _pem(_apple_signing).replace("\n", "\\n"))
    get_settings.cache_clear()
    monkeypatch.setattr(oidc, "HTTP_TRANSPORT", httpx.MockTransport(fake.handler))
    oidc._jwks_cache.clear()
    yield fake
    get_settings.cache_clear()


def start(client, provider: str, next_path: str = "/videos") -> dict:
    resp = client.get(
        f"/api/v1/auth/oauth/{provider}/start", params={"next": next_path}, follow_redirects=False
    )
    assert resp.status_code == 303, resp.text
    return {k: v[0] for k, v in parse_qs(urlsplit(resp.headers["location"]).query).items()}


def callback(client, provider: str, params: dict, **extra):
    code = f"codigo:{params['nonce']}"
    if provider == "apple":
        return client.post(
            "/api/v1/auth/oauth/apple/callback",
            data={"code": code, "state": params["state"], **extra},
            follow_redirects=False,
        )
    return client.get(
        "/api/v1/auth/oauth/google/callback",
        params={"code": code, "state": params["state"], **extra},
        follow_redirects=False,
    )


def error_of(resp) -> str | None:
    return parse_qs(urlsplit(resp.headers["location"]).query).get("oauth_error", [None])[0]


# ---------------------------------------------------------------- casos


def test_sem_credenciais_os_botoes_ficam_desligados(client):
    assert client.get("/api/v1/auth/providers").json() == {
        "google": {"configured": False, "label": "Google"},
        "apple": {"configured": False, "label": "Apple"},
    }
    resp = client.get("/api/v1/auth/oauth/google/start", follow_redirects=False)
    assert error_of(resp) == "not_configured"


def test_google_cria_conta_entra_e_volta_para_a_tela(client, providers):
    params = start(client, "google")
    assert params["code_challenge_method"] == "S256" and params["client_id"] == GOOGLE_ID
    resp = callback(client, "google", params)
    assert resp.status_code == 303
    assert resp.headers["location"].endswith("/videos")
    # PKCE: o segredo do início foi mandado na troca do código.
    assert providers.last_form["code_verifier"]
    me = client.get("/api/me").json()["user"]
    assert me["email"] == "nova@example.com"
    assert me["name"] == "Nova Pessoa"
    assert me["providers"] == ["google"] and me["has_password"] is False

    # Segundo login com a mesma conta Google entra na mesma conta.
    client.cookies.clear()
    callback(client, "google", start(client, "google"))
    assert client.get("/api/me").json()["user"]["id"] == me["id"]


def test_google_liga_a_conta_que_ja_existia_pelo_email(client, outbox, providers):
    make_user(client, outbox, email="ana@example.com")
    original = client.get("/api/me").json()["user"]["id"]
    client.cookies.clear()
    providers.claims = {"email": "ana@example.com"}
    callback(client, "google", start(client, "google"))
    me = client.get("/api/me").json()["user"]
    assert me["id"] == original
    assert me["providers"] == ["google"] and me["has_password"] is True


def test_conta_so_google_nao_entra_com_senha(client, providers):
    callback(client, "google", start(client, "google"))
    client.cookies.clear()
    resp = client.post("/api/auth/login", json={"email": "nova@example.com", "password": "qualquer-1234"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "social_login_required"
    assert "Google" in resp.json()["error"]["message"]


def test_apple_por_post_com_nome_do_primeiro_login(client, providers):
    params = start(client, "apple", "/dashboard")
    assert params["response_mode"] == "form_post"
    # O cookie da Apple é Secure (exige HTTPS); o cliente de teste usa http, então ele é repetido aqui.
    binding = client.cookies.get("clipo_oidc", path="/api/v1/auth/oauth")
    client.cookies.set("clipo_oidc", binding, path="/api/v1/auth/oauth")
    resp = callback(
        client, "apple", params, user=json.dumps({"name": {"firstName": "Bia", "lastName": "Lima"}})
    )
    assert resp.status_code == 303 and resp.headers["location"].endswith("/dashboard")
    me = client.get("/api/me").json()["user"]
    assert me["name"] == "Bia Lima" and me["providers"] == ["apple"]

    # O segredo enviado à Apple é um JWT ES256 assinado com a chave .p8.
    secret = providers.last_form["client_secret"]
    claims = jwt.decode(
        secret, _apple_signing.public_key(), algorithms=["ES256"], audience="https://appleid.apple.com"
    )
    assert claims["iss"] == "TEAMID1234" and claims["sub"] == APPLE_ID
    assert jwt.get_unverified_header(secret)["kid"] == "KEYID12345"


@pytest.mark.parametrize(
    "claims, expected",
    [
        ({"aud": "outro-app"}, "invalid_token"),
        ({"iss": "https://falso.example.com"}, "invalid_token"),
        ({"exp": int(time.time()) - 3600, "iat": int(time.time()) - 7200}, "invalid_token"),
        ({"nonce": "nonce-errado"}, "invalid_token"),
        ({"email_verified": False}, "email_not_verified"),
    ],
)
def test_id_token_invalido_e_recusado(client, providers, claims, expected):
    providers.claims = claims
    resp = callback(client, "google", start(client, "google"))
    assert error_of(resp) == expected
    assert client.get("/api/me").status_code == 401


def test_state_forjado_reusado_ou_de_outro_navegador(client, providers):
    params = start(client, "google")
    ok = callback(client, "google", params)
    assert ok.status_code == 303 and error_of(ok) is None
    reused = callback(client, "google", params)  # o state é de uso único
    assert error_of(reused) == "expired"

    params = start(client, "google")
    forged = callback(client, "google", {**params, "state": "forjado"})
    assert error_of(forged) == "expired"

    params = start(client, "google")
    client.cookies.delete("clipo_oidc", path="/api/v1/auth/oauth")
    other_browser = callback(client, "google", params)
    assert error_of(other_browser) == "expired"


def test_provedor_recusa_o_codigo(client, providers):
    providers.token_status = 400
    assert error_of(callback(client, "google", start(client, "google"))) == "exchange_failed"


def test_destino_externo_vira_painel(client, providers):
    params = start(client, "google", "//site-malicioso.com")
    resp = callback(client, "google", params)
    assert resp.headers["location"].endswith("/dashboard")


def test_login_social_fica_no_log(client, providers):
    callback(client, "google", start(client, "google"))
    db = client.app.state.db
    events = [
        d["event"] for d in client.portal.call(lambda: db.system_logs.find({"platform": "google"}).to_list())
    ]
    assert "oauth.login.success" in events
    assert "http.request" in events  # troca de código e chaves, pelo cliente com log

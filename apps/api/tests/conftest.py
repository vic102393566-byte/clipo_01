import os
import uuid
from pathlib import Path

from cryptography.fernet import Fernet


def _root_env() -> dict[str, str]:
    """Chaves do S3 local vêm do .env da raiz (o mesmo do Docker); sem ele, os testes de arquivo pulam."""
    path = Path(__file__).resolve().parents[3] / ".env"
    if not path.exists():
        return {}
    pairs = (
        line.split("=", 1)
        for line in path.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    return {k.strip(): v.strip() for k, v in pairs}


_env = _root_env()
S3_AVAILABLE = bool(_env.get("S3_ACCESS_KEY_ID"))

# Configuração de teste antes de importar a aplicação (create_app lê o ambiente).
os.environ.update(
    {
        "ENVIRONMENT": "test",
        "JWT_SECRET": "teste-" + "x" * 40,
        "COOKIE_SECURE": "false",
        "MONGODB_URL": os.environ.get("TEST_MONGODB_URL", "mongodb://localhost:27017/?directConnection=true"),
        "MONGODB_DB": f"clipo_test_{uuid.uuid4().hex[:8]}",
        "S3_ENDPOINT_URL": os.environ.get("TEST_S3_URL", "http://localhost:8333"),
        "S3_BUCKET": "clipo-test",
        "S3_ACCESS_KEY_ID": _env.get("S3_ACCESS_KEY_ID", ""),
        "S3_SECRET_ACCESS_KEY": _env.get("S3_SECRET_ACCESS_KEY", ""),
        "TOKEN_ENCRYPTION_KEY": Fernet.generate_key().decode(),
        "GEMINI_API_KEY": "",
        "ASAAS_API_KEY": "",
        "ASAAS_WEBHOOK_TOKEN": "",
        # Conta nova começa no teste do Básico (os testes de cota mexem nos limites dele).
        "TRIAL_PLAN_ID": "basico",
        "TRIAL_DAYS": "7",
    }
)

import pytest
from fastapi.testclient import TestClient

from clipo_api.core.config import get_settings
from clipo_api.routers import auth as auth_router


class Outbox:
    """Guarda os e-mails que seriam enviados, com o token extraído do link."""

    def __init__(self) -> None:
        self.messages: list[dict[str, str]] = []

    def last_token(self, kind: str) -> str:
        url = next(m["url"] for m in reversed(self.messages) if m["kind"] == kind)
        return url.split("token=", 1)[1]


@pytest.fixture
def outbox(monkeypatch: pytest.MonkeyPatch) -> Outbox:
    box = Outbox()

    async def verification(to: str, name: str, url: str) -> None:
        box.messages.append({"kind": "verify", "to": to, "url": url})

    async def reset(to: str, url: str) -> None:
        box.messages.append({"kind": "reset", "to": to, "url": url})

    monkeypatch.setattr(auth_router, "send_verification_email", verification)
    monkeypatch.setattr(auth_router, "send_password_reset_email", reset)
    return box


@pytest.fixture
def client(outbox: Outbox):
    get_settings.cache_clear()
    from clipo_api.main import create_app

    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
        # Cada teste começa com o banco vazio.
        test_client.portal.call(app.state.mongo.drop_database, get_settings().mongodb_db)


def csrf_headers(client: TestClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("clipo_csrf", "")}


def make_user(
    client: TestClient,
    outbox: Outbox,
    email: str = "ana@example.com",
    password: str = "senha-forte-123",
) -> None:
    """Cadastra, confirma o e-mail e entra. Deixa os cookies de sessão no client."""
    resp = client.post("/api/auth/register", json={"name": "Ana", "email": email, "password": password})
    assert resp.status_code == 202
    resp = client.post("/api/auth/verify-email", json={"token": outbox.last_token("verify")})
    assert resp.status_code == 200
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text


def allow_social_accounts(monkeypatch: pytest.MonkeyPatch, count: int = 3) -> None:
    """O Básico (plano do teste de conta nova) conecta uma rede só; alguns testes precisam de mais."""
    from dataclasses import replace

    from clipo_api.core import plans

    original = plans.all_plans

    async def patched(db):
        current = await original(db)
        return {**current, "basico": replace(current["basico"], social_accounts=count)}

    monkeypatch.setattr(plans, "all_plans", patched)

"""Minha conta: perfil, foto, troca de e-mail, sessões, formas de entrar, papéis e LGPD."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from conftest import S3_AVAILABLE, csrf_headers, make_user

from clipo_api.core.permissions import PERMISSIONS, ROLES
from clipo_api.routers import account as account_router
from clipo_api.services.account_lifecycle import purge_due_accounts

PASSWORD = "senha-forte-123"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def mails(monkeypatch):
    sent: list[dict] = []

    async def change(to, url, *, is_new_address, new_email):
        sent.append({"to": to, "token": url.split("token=", 1)[1], "new": is_new_address})

    async def deletion(to, when, url):
        sent.append({"to": to, "kind": "deletion"})

    monkeypatch.setattr(account_router, "send_email_change_email", change)
    monkeypatch.setattr(account_router, "send_account_deletion_email", deletion)
    return sent


def db_of(client):
    return client.app.state.db


def set_role(client, email, role):
    client.portal.call(db_of(client).users.update_one, {"email": email}, {"$set": {"role": role}})
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"email": email, "password": PASSWORD}).status_code == 200


# ---------------------------------------------------------------- perfil


def test_perfil_editar_e_validar(client, outbox):
    make_user(client, outbox)
    resp = client.patch(
        "/api/v1/account",
        json={
            "name": "  Ana   Souza ",
            "locale": "en-US",
            "theme": "light",
            "notifications": {"product_news": True},
        },
        headers=csrf_headers(client),
    )
    account = resp.json()["account"]
    assert account["name"] == "Ana Souza"
    assert (account["locale"], account["theme"]) == ("en-US", "light")
    assert account["notifications"]["product_news"] is True
    bad = client.patch("/api/v1/account", json={"theme": "rosa"}, headers=csrf_headers(client))
    assert bad.status_code == 422


@pytest.mark.skipif(not S3_AVAILABLE, reason="precisa do S3 local")
def test_foto_de_perfil_confere_o_conteudo(client, outbox):
    make_user(client, outbox)
    signed = client.post(
        "/api/v1/account/avatar/upload-url",
        json={"content_type": "image/png", "size_bytes": len(PNG)},
        headers=csrf_headers(client),
    ).json()
    httpx.put(signed["url"], content=PNG, headers={"Content-Type": "image/png"})
    account = client.post(
        "/api/v1/account/avatar", json={"key": signed["key"]}, headers=csrf_headers(client)
    ).json()
    assert account["account"]["avatar_url"] == f"/media/{signed['key']}"

    # Um arquivo que diz ser PNG, mas não é, é recusado e apagado.
    fake = client.post(
        "/api/v1/account/avatar/upload-url",
        json={"content_type": "image/png", "size_bytes": 10},
        headers=csrf_headers(client),
    ).json()
    httpx.put(fake["url"], content=b"<script>1</script>", headers={"Content-Type": "image/png"})
    resp = client.post("/api/v1/account/avatar", json={"key": fake["key"]}, headers=csrf_headers(client))
    assert resp.status_code == 400 and resp.json()["error"]["code"] == "invalid_image"


# ---------------------------------------------------------------- troca de e-mail


def test_troca_de_email_precisa_dos_dois_enderecos(client, outbox, mails):
    make_user(client, outbox)
    resp = client.post(
        "/api/v1/account/email",
        json={"new_email": "ana.nova@example.com", "current_password": PASSWORD},
        headers=csrf_headers(client),
    )
    assert resp.status_code == 202
    old_link = next(m for m in mails if not m["new"])
    new_link = next(m for m in mails if m["new"])
    assert old_link["to"] == "ana@example.com" and new_link["to"] == "ana.nova@example.com"

    first = client.post("/api/v1/account/email/confirm", json={"token": new_link["token"]})
    assert first.json()["status"] == "waiting_other"
    assert client.get("/api/v1/account").json()["account"]["email"] == "ana@example.com"
    second = client.post("/api/v1/account/email/confirm", json={"token": old_link["token"]})
    assert second.json()["status"] == "done"
    assert client.get("/api/v1/account").json()["account"]["email"] == "ana.nova@example.com"
    # O link não vale duas vezes.
    again = client.post("/api/v1/account/email/confirm", json={"token": old_link["token"]})
    assert again.status_code == 400


def test_troca_de_email_pede_senha_e_recusa_email_em_uso(client, outbox, mails):
    make_user(client, outbox, email="bia@example.com")
    client.cookies.clear()
    make_user(client, outbox, email="ana@example.com")
    no_password = client.post(
        "/api/v1/account/email", json={"new_email": "x@example.com"}, headers=csrf_headers(client)
    )
    assert no_password.json()["error"]["code"] == "wrong_password"
    taken = client.post(
        "/api/v1/account/email",
        json={"new_email": "bia@example.com", "current_password": PASSWORD},
        headers=csrf_headers(client),
    )
    assert taken.status_code == 409


# ---------------------------------------------------------------- sessões e formas de entrar


def test_sessoes_abertas_e_sair_dos_outros_aparelhos(client, outbox):
    make_user(client, outbox)
    laptop = dict(client.cookies)
    # Um segundo "aparelho": o mesmo cliente com outros cookies (outra sessão no mesmo app).
    client.cookies.clear()
    assert (
        client.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD}).status_code
        == 200
    )
    phone = dict(client.cookies)
    client.cookies.clear()
    client.cookies.update(laptop)

    sessions = client.get("/api/v1/account/sessions").json()["items"]
    assert len(sessions) == 2
    assert sum(s["current"] for s in sessions) == 1

    client.post("/api/v1/account/sessions/revoke-others", headers=csrf_headers(client))
    assert len(client.get("/api/v1/account/sessions").json()["items"]) == 1
    assert client.get("/api/me").status_code == 200
    client.cookies.clear()
    client.cookies.update(phone)
    assert client.get("/api/me").status_code == 401


def test_nao_desliga_o_ultimo_jeito_de_entrar(client, outbox):
    make_user(client, outbox)
    db = db_of(client)
    client.portal.call(
        db.users.update_one,
        {"email": "ana@example.com"},
        {
            "$set": {
                "password_hash": None,
                "identities": [{"provider": "google", "subject": "g1", "linked_at": datetime.now(UTC)}],
            }
        },
    )
    resp = client.delete("/api/v1/account/identities/google", headers=csrf_headers(client))
    assert resp.json()["error"]["code"] == "last_login_method"
    created = client.post(
        "/api/v1/account/password", json={"new_password": "senha-nova-789"}, headers=csrf_headers(client)
    )
    assert created.status_code == 200
    assert client.delete("/api/v1/account/identities/google", headers=csrf_headers(client)).status_code == 200
    assert client.get("/api/v1/account/identities").json() == {"has_password": True, "items": []}


# ---------------------------------------------------------------- papéis e permissões

ROUTES = {
    "logs:read": ("GET", "/api/v1/admin/logs"),
    "audit:read": ("GET", "/api/v1/admin/audit"),
}


@pytest.mark.parametrize("role", ROLES)
def test_matriz_de_permissoes(client, outbox, role):
    make_user(client, outbox, email=f"{role.replace('_', '')}@example.com")
    set_role(client, f"{role.replace('_', '')}@example.com", role)
    for permission, (method, path) in ROUTES.items():
        expected = 200 if permission in PERMISSIONS[role] else 403
        assert client.request(method, path).status_code == expected, (role, permission)
    can_manage = "roles:manage" in PERMISSIONS[role]
    me = client.get("/api/me").json()["user"]["id"]
    resp = client.patch(f"/api/v1/admin/users/{me}/role", json={"role": "user"}, headers=csrf_headers(client))
    assert (resp.status_code != 403) == can_manage


def test_troca_de_papel_derruba_sessoes_e_protege_o_ultimo_super_admin(client, outbox):
    make_user(client, outbox, email="dono@example.com")
    set_role(client, "dono@example.com", "super_admin")
    me = client.get("/api/me").json()["user"]["id"]
    last = client.patch(f"/api/v1/admin/users/{me}/role", json={"role": "user"}, headers=csrf_headers(client))
    assert last.json()["error"]["code"] == "last_super_admin"

    db = db_of(client)
    other = client.portal.call(db.users.find_one, {"email": "dono@example.com"})
    client.cookies.clear()
    make_user(client, outbox, email="ana@example.com")
    ana = client.get("/api/me").json()["user"]["id"]
    client.cookies.clear()
    client.post("/api/auth/login", json={"email": "dono@example.com", "password": PASSWORD})
    resp = client.patch(
        f"/api/v1/admin/users/{ana}/role", json={"role": "support"}, headers=csrf_headers(client)
    )
    assert resp.json() == {"id": ana, "role": "support"}
    active = client.portal.call(db.sessions.count_documents, {"user_id": ana, "revoked_at": None})
    assert active == 0
    assert other["role"] == "super_admin"


# ---------------------------------------------------------------- LGPD


def test_exportar_meus_dados_sem_segredos(client, outbox):
    make_user(client, outbox)
    resp = client.get("/api/v1/account/export")
    assert resp.status_code == 200
    assert "attachment" in resp.headers["content-disposition"]
    data = resp.json()
    assert data["account"]["email"] == "ana@example.com"
    text = json.dumps(data)
    assert "password_hash" not in text and "token_hash" not in text
    assert any(log["event"] == "login.success" for log in data["activity_logs"])


def test_excluir_conta_desistir_e_apagar_de_vez(client, outbox, mails):
    make_user(client, outbox)
    wrong = client.post("/api/v1/account/delete", json={"confirmation": "sim"}, headers=csrf_headers(client))
    assert wrong.json()["error"]["code"] == "confirmation_required"
    resp = client.post(
        "/api/v1/account/delete",
        json={"confirmation": "excluir", "current_password": PASSWORD},
        headers=csrf_headers(client),
    )
    assert resp.status_code == 202
    assert any(m.get("kind") == "deletion" for m in mails)
    assert client.get("/api/me").status_code == 401  # todas as sessões caíram

    # Entrar de novo dentro do prazo cancela a exclusão.
    client.cookies.clear()
    client.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD})
    assert client.get("/api/v1/account").json()["account"]["status"] == "active"

    # Pede de novo e deixa o prazo passar: a conta some.
    client.post(
        "/api/v1/account/delete",
        json={"confirmation": "EXCLUIR", "current_password": PASSWORD},
        headers=csrf_headers(client),
    )
    db = db_of(client)
    client.portal.call(
        db.users.update_one,
        {"email": "ana@example.com"},
        {"$set": {"deletion_scheduled_for": datetime.now(UTC) - timedelta(minutes=1)}},
    )
    assert client.portal.call(purge_due_accounts, db) == 1
    assert client.portal.call(db.users.find_one, {"email": "ana@example.com"}) is None
    assert client.portal.call(db.sessions.count_documents, {}) == 0
    actions = [a["action"] for a in client.portal.call(lambda: db.audit_logs.find().to_list())]
    assert {"account.deletion_requested", "account.deletion_cancelled", "account.purged"} <= set(actions)

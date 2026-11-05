from datetime import UTC, datetime, timedelta

from conftest import csrf_headers, make_user

PASSWORD = "senha-forte-123"


def test_cadastro_confirmacao_e_login(client, outbox):
    resp = client.post(
        "/api/auth/register",
        json={
            "name": "  Ana  Souza ",
            "email": "Ana@Example.com",
            "password": PASSWORD,
        },
    )
    assert resp.status_code == 202
    assert outbox.messages[-1]["to"] == "ana@example.com"

    # Antes de confirmar o e-mail, a senha certa não basta.
    resp = client.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD})
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "email_not_verified"

    assert (
        client.post("/api/auth/verify-email", json={"token": outbox.last_token("verify")}).status_code == 200
    )
    resp = client.post("/api/auth/login", json={"email": "ANA@example.com", "password": PASSWORD})
    assert resp.status_code == 200
    assert {"clipo_access", "clipo_refresh", "clipo_csrf"} <= set(client.cookies.keys())

    me = client.get("/api/me").json()["user"]
    assert me["email"] == "ana@example.com"
    assert me["name"] == "Ana Souza"
    assert me["role"] == "user"
    assert me["email_verified"] is True
    assert "password_hash" not in me


def test_cadastro_repetido_nao_revela_conta(client, outbox):
    body = {"name": "Ana", "email": "ana@example.com", "password": PASSWORD}
    first = client.post("/api/auth/register", json=body)
    second = client.post("/api/auth/register", json=body)
    assert first.status_code == second.status_code == 202
    assert first.json() == second.json()
    assert len(outbox.messages) == 1


def test_senha_curta_recusada(client, outbox):
    resp = client.post(
        "/api/auth/register",
        json={"name": "Ana", "email": "ana@example.com", "password": "curta"},
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


def test_erro_de_login_igual_para_email_inexistente(client, outbox):
    make_user(client, outbox)
    client.cookies.clear()
    wrong = client.post(
        "/api/auth/login",
        json={"email": "ana@example.com", "password": "senha-errada-1"},
    )
    unknown = client.post(
        "/api/auth/login",
        json={"email": "ninguem@example.com", "password": "senha-errada-1"},
    )
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


def test_limite_de_tentativas_por_email(client, outbox):
    codes = [
        client.post(
            "/api/auth/login",
            json={"email": "alvo@example.com", "password": "tentativa-123"},
        ).status_code
        for _ in range(6)
    ]
    assert codes[:5] == [401] * 5
    assert codes[5] == 429


def test_renovacao_gira_o_token(client, outbox):
    make_user(client, outbox)
    old_refresh = client.cookies.get("clipo_refresh")
    resp = client.post("/api/auth/refresh", headers=csrf_headers(client))
    assert resp.status_code == 200
    assert client.cookies.get("clipo_refresh") != old_refresh
    assert client.get("/api/me").status_code == 200


def test_reuso_de_token_antigo_derruba_todas_as_sessoes(client, outbox):
    make_user(client, outbox)
    old_refresh = client.cookies.get("clipo_refresh")
    assert client.post("/api/auth/refresh", headers=csrf_headers(client)).status_code == 200

    # Dentro da janela de 15 s, o reuso é tratado como duas abas renovando juntas.
    stolen = {"clipo_refresh": old_refresh, "clipo_csrf": "x"}
    # Quem roubou só tem o refresh antigo (troca os cookies, não soma aos atuais).
    client.cookies.clear()
    client.cookies.update(stolen)
    resp = client.post("/api/auth/refresh", headers={"X-CSRF-Token": "x"})
    assert resp.status_code == 409

    # Fora da janela, é roubo: todas as sessões da pessoa caem.
    db = client.app.state.db
    client.portal.call(
        db.sessions.update_many,
        {"revoked_at": {"$ne": None}},
        {"$set": {"revoked_at": datetime.now(UTC) - timedelta(minutes=5)}},
    )
    client.cookies.clear()
    client.cookies.update(stolen)
    resp = client.post("/api/auth/refresh", headers={"X-CSRF-Token": "x"})
    assert resp.status_code == 401
    active = client.portal.call(db.sessions.count_documents, {"revoked_at": None})
    assert active == 0


def test_sair_encerra_a_sessao_na_hora(client, outbox):
    make_user(client, outbox)
    access = client.cookies.get("clipo_access")
    assert client.post("/api/auth/logout", headers=csrf_headers(client)).status_code == 204
    # O token de acesso ainda não venceu, mas a sessão dele foi encerrada.
    resp = client.get("/api/me", headers={"Authorization": f"Bearer {access}"})
    assert resp.status_code == 401


def test_csrf_obrigatorio_com_sessao(client, outbox):
    make_user(client, outbox)
    resp = client.post("/api/auth/logout")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "csrf_failed"
    resp = client.post("/api/auth/logout", headers={"X-CSRF-Token": "valor-errado"})
    assert resp.status_code == 403


def test_troca_de_senha_por_email(client, outbox):
    make_user(client, outbox)
    assert client.post("/api/auth/forgot-password", json={"email": "ana@example.com"}).status_code == 202
    token = outbox.last_token("reset")

    resp = client.post("/api/auth/reset-password", json={"token": token, "password": "nova-senha-456"})
    assert resp.status_code == 200
    # O link só vale uma vez.
    again = client.post("/api/auth/reset-password", json={"token": token, "password": "outra-senha-789"})
    assert again.status_code == 400

    db = client.app.state.db
    assert client.portal.call(db.sessions.count_documents, {"revoked_at": None}) == 0
    client.cookies.clear()
    assert (
        client.post("/api/auth/login", json={"email": "ana@example.com", "password": PASSWORD}).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/login",
            json={"email": "ana@example.com", "password": "nova-senha-456"},
        ).status_code
        == 200
    )


def test_esqueci_senha_nao_revela_conta(client, outbox):
    known = client.post("/api/auth/forgot-password", json={"email": "ana@example.com"})
    assert known.status_code == 202
    assert outbox.messages == []


def test_trocar_senha_logado(client, outbox):
    make_user(client, outbox)
    headers = csrf_headers(client)
    wrong = client.post(
        "/api/auth/change-password",
        json={"current_password": "errada-000000", "new_password": "nova-senha-456"},
        headers=headers,
    )
    assert wrong.status_code == 400
    assert wrong.json()["error"]["code"] == "wrong_password"

    ok = client.post(
        "/api/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "nova-senha-456"},
        headers=headers,
    )
    assert ok.status_code == 200
    # A sessão deste aparelho continua valendo.
    assert client.get("/api/me").status_code == 200
    client.cookies.clear()
    login = client.post("/api/auth/login", json={"email": "ana@example.com", "password": "nova-senha-456"})
    assert login.status_code == 200

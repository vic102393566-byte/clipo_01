import pytest

from clipo_api.db.repository import OwnedRepository, OwnershipError
from clipo_api.services import storage

# Únicas rotas que respondem sem sessão. Uma rota nova fora desta lista precisa exigir login.
PUBLIC_ROUTES = {
    ("GET", "/api/health"),
    ("POST", "/api/auth/register"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/refresh"),
    ("POST", "/api/auth/logout"),
    ("POST", "/api/auth/verify-email"),
    ("POST", "/api/auth/resend-verification"),
    ("POST", "/api/auth/forgot-password"),
    ("POST", "/api/auth/reset-password"),
    # Login com Google e Apple: quem chama ainda não tem sessão.
    ("GET", "/api/v1/auth/providers"),
    # Página de preços.
    ("GET", "/api/v1/plans"),
    ("GET", "/api/v1/auth/oauth/{provider}/start"),
    # Aberto pelo link do e-mail, que pode chegar com a pessoa deslogada.
    ("POST", "/api/v1/account/email/confirm"),
    # Tela do convite: mostra de quem é antes de a pessoa entrar ou criar a conta.
    ("POST", "/api/v1/workspace/invites/preview"),
    # Tarefa agendada da Vercel: protegida pelo CRON_SECRET no cabeçalho, não por sessão.
    ("GET", "/api/v1/internal/cron"),
}


def test_toda_rota_nao_publica_exige_sessao(client):
    # Lê as rotas do OpenAPI: pega também as que forem criadas depois deste teste.
    checked = 0
    for route_path, operations in client.app.openapi()["paths"].items():
        for method in operations:
            method = method.upper()
            if (method, route_path) in PUBLIC_ROUTES:
                continue
            path = route_path.replace("{", "").replace("}", "")
            resp = client.request(method, path, params={"key": "x"}, json={})
            assert resp.status_code == 401, f"{method} {route_path} respondeu {resp.status_code} sem sessão"
            checked += 1
    assert checked >= 3


def test_health_e_cabecalhos_de_seguranca(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "database": "ok"}
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert "default-src 'none'" in resp.headers["Content-Security-Policy"]
    assert len(resp.headers["X-Request-ID"]) >= 8


def test_erro_em_formato_unico(client):
    resp = client.get("/api/nao-existe")
    assert resp.status_code == 404
    assert set(resp.json()["error"]) >= {"code", "message"}


def test_repositorio_isola_usuarios(client):
    db = client.app.state.db
    ana = OwnedRepository(db.notes, "user-ana")
    bia = OwnedRepository(db.notes, "user-bia")
    call = client.portal.call

    doc = call(ana.insert, {"title": "roteiro"})
    assert call(ana.get, doc["_id"])["title"] == "roteiro"

    # Bia não lê, não lista, não altera e não apaga o que é da Ana.
    assert call(bia.get, doc["_id"]) is None
    assert call(bia.list) == []
    assert call(bia.update, doc["_id"], {"title": "invadido"}) is None
    assert call(bia.delete, doc["_id"]) is False
    assert call(ana.get, doc["_id"])["title"] == "roteiro"


def test_repositorio_recusa_dono_vindo_de_fora(client):
    repo = OwnedRepository(client.app.state.db.notes, "user-ana")
    with pytest.raises(OwnershipError):
        client.portal.call(repo.insert, {"title": "x", "user_id": "user-bia"})
    with pytest.raises(OwnershipError):
        client.portal.call(repo.list, {"user_id": "user-bia"})
    with pytest.raises(OwnershipError):
        client.portal.call(repo.get, {"$ne": None})


def test_chave_de_arquivo_so_do_proprio_usuario():
    key = storage.new_object_key("u1", "uploads", "../../etc/passwd vídeo.mp4")
    assert key.startswith("users/u1/uploads/")
    assert ".." not in key
    assert storage.owns_key("u1", key)
    assert not storage.owns_key("u2", key)
    assert not storage.owns_key("u1", "users/u1/../u2/arquivo.mp4")

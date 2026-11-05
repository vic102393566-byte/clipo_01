"""Workspace compartilhado: convite, aceite, papéis e limite de lugares do plano."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from conftest import csrf_headers, make_user

from clipo_api.core.config import get_settings
from clipo_api.routers import workspace as ws_router


@pytest.fixture
def invites(monkeypatch):
    sent: list[dict] = []

    async def fake(to: str, inviter: str, role_label: str, url: str) -> None:
        sent.append({"to": to, "token": url.split("token=", 1)[1], "role": role_label})

    monkeypatch.setattr(ws_router.email_service, "send_workspace_invite_email", fake)
    return sent


def login(client, email: str, password: str = "senha-forte-123") -> None:
    client.cookies.clear()
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text


def db(client):
    return client.app.state.mongo[get_settings().mongodb_db]


def set_plan(client, email: str, plan_id: str) -> None:
    client.portal.call(db(client).users.update_one, {"email": email}, {"$set": {"plan_id": plan_id}})


def owner_and_member(client, outbox, invites, role: str = "editor") -> str:
    """Ana (dono, plano Pro) convida Bia. Devolve o id do workspace da Ana."""
    make_user(client, outbox, "ana@example.com")
    set_plan(client, "ana@example.com", "pro")
    owner_id = client.get("/api/me").json()["user"]["id"]
    resp = client.post(
        "/api/v1/workspace/invites",
        json={"email": "bia@example.com", "role": role},
        headers=csrf_headers(client),
    )
    assert resp.status_code == 201, resp.text
    client.cookies.clear()
    make_user(client, outbox, "bia@example.com")
    token = invites[-1]["token"]
    assert (
        client.post(
            "/api/v1/workspace/invites/preview", json={"token": token}, headers=csrf_headers(client)
        ).json()["role"]
        == role
    )
    resp = client.post(
        "/api/v1/workspace/invites/accept", json={"token": token}, headers=csrf_headers(client)
    )
    assert resp.status_code == 200, resp.text
    return owner_id


def insert_video(client, owner_id: str, title: str = "Live de domingo") -> str:
    vid = uuid4().hex
    now = datetime.now(UTC)
    client.portal.call(
        db(client).videos.insert_one,
        {
            "_id": vid,
            "user_id": owner_id,
            "title": title,
            "status": "ready",
            "size_bytes": 10,
            "deleted_at": None,
            "created_at": now,
            "updated_at": now,
            "tags": [],
        },
    )
    return vid


def test_membro_ve_os_videos_do_dono_depois_de_aceitar(client, outbox, invites):
    owner_id = owner_and_member(client, outbox, invites)
    vid = insert_video(client, owner_id)

    # O aceite já troca para o workspace da Ana.
    spaces = client.get("/api/v1/workspaces").json()
    assert spaces["current"] == owner_id and spaces["role"] == "editor"
    assert [v["id"] for v in client.get("/api/v1/videos").json()["items"]] == [vid]

    # De volta ao próprio workspace, os vídeos da Ana somem.
    me = client.get("/api/me").json()["user"]["id"]
    client.post("/api/v1/workspaces/current", json={"workspace_id": me}, headers=csrf_headers(client))
    assert client.get("/api/v1/videos").json()["items"] == []


def test_revisor_le_mas_nao_envia_nem_publica(client, outbox, invites):
    owner_owner = owner_and_member(client, outbox, invites, role="reviewer")
    insert_video(client, owner_owner)
    assert client.get("/api/v1/videos").status_code == 200
    resp = client.post(
        "/api/v1/uploads",
        json={"filename": "a.mp4", "size_bytes": 100, "content_type": "video/mp4"},
        headers=csrf_headers(client),
    )
    assert resp.status_code == 403 and resp.json()["error"]["code"] == "workspace_forbidden"
    resp = client.post("/api/v1/publications", json={}, headers=csrf_headers(client))
    assert resp.status_code in (403, 422)
    assert (
        client.post(
            "/api/v1/workspace/invites",
            json={"email": "c@example.com", "role": "editor"},
            headers=csrf_headers(client),
        ).status_code
        == 403
    )


def test_convite_so_vale_para_o_email_convidado(client, outbox, invites):
    make_user(client, outbox, "ana@example.com")
    set_plan(client, "ana@example.com", "pro")
    client.post(
        "/api/v1/workspace/invites",
        json={"email": "bia@example.com", "role": "writer"},
        headers=csrf_headers(client),
    )
    client.cookies.clear()
    make_user(client, outbox, "caio@example.com")
    resp = client.post(
        "/api/v1/workspace/invites/accept", json={"token": invites[-1]["token"]}, headers=csrf_headers(client)
    )
    assert resp.status_code == 403 and resp.json()["error"]["code"] == "invite_wrong_account"


def test_workspace_alheio_no_cookie_cai_no_proprio(client, outbox, invites):
    make_user(client, outbox, "ana@example.com")
    ana = client.get("/api/me").json()["user"]["id"]
    insert_video(client, ana)
    client.cookies.clear()
    make_user(client, outbox, "bia@example.com")
    resp = client.get("/api/v1/videos", headers={"X-Workspace": ana})
    assert resp.json()["items"] == []
    resp = client.post("/api/v1/workspaces/current", json={"workspace_id": ana}, headers=csrf_headers(client))
    assert resp.status_code == 404


def test_plano_limita_lugares_e_dono_remove_membro(client, outbox, invites):
    make_user(client, outbox, "ana@example.com")
    # Básico: 1 lugar (só o dono).
    resp = client.post(
        "/api/v1/workspace/invites",
        json={"email": "bia@example.com", "role": "editor"},
        headers=csrf_headers(client),
    )
    assert resp.status_code == 402 and resp.json()["error"]["code"] == "team_seats_exhausted"

    set_plan(client, "ana@example.com", "pro")
    first = client.post(
        "/api/v1/workspace/invites",
        json={"email": "bia@example.com", "role": "editor"},
        headers=csrf_headers(client),
    )
    assert first.status_code == 201
    dup = client.post(
        "/api/v1/workspace/invites",
        json={"email": "BIA@example.com", "role": "writer"},
        headers=csrf_headers(client),
    )
    assert dup.status_code == 409
    client.post(
        "/api/v1/workspace/invites",
        json={"email": "caio@example.com", "role": "writer"},
        headers=csrf_headers(client),
    )
    full = client.post(
        "/api/v1/workspace/invites",
        json={"email": "duda@example.com", "role": "writer"},
        headers=csrf_headers(client),
    )
    assert full.status_code == 402

    members = client.get("/api/v1/workspace/members").json()
    assert members["seats"] == {"used": 3, "limit": 3}
    assert [m["role"] for m in members["items"]] == ["owner", "editor", "writer"]

    resp = client.patch(
        f"/api/v1/workspace/members/{first.json()['id']}",
        json={"role": "reviewer"},
        headers=csrf_headers(client),
    )
    assert resp.json()["role_label"] == "Revisor"
    assert client.delete(
        f"/api/v1/workspace/members/{first.json()['id']}", headers=csrf_headers(client)
    ).json() == {"ok": True}
    assert client.get("/api/v1/workspace/members").json()["seats"]["used"] == 2

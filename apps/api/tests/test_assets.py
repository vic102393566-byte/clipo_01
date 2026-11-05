"""Biblioteca de ativos (S3 e FFmpeg locais) e modelos de edição."""

import shutil
import subprocess
from pathlib import Path

import httpx
import pytest
from conftest import S3_AVAILABLE, csrf_headers, make_user

from clipo_api import worker
from clipo_api.services import jobs

needs_media = pytest.mark.skipif(
    not S3_AVAILABLE or shutil.which("ffmpeg") is None, reason="precisa do S3 local e do FFmpeg"
)


def drain(client, tmp_path: Path) -> list[str]:
    db = client.app.state.db

    async def run() -> list[str]:
        outcomes = []
        while job := await jobs.claim(db, "worker-teste"):
            outcomes.append(await worker.run_job(db, job, "worker-teste", tmp_path))
        return outcomes

    return client.portal.call(run)


def make_media(tmp_path: Path, name: str, *args: str) -> Path:
    path = tmp_path / name
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args, str(path)], check=True)
    return path


def send(client, path: Path, kind: str, content_type: str, **extra) -> dict:
    resp = client.post(
        "/api/v1/assets/uploads",
        json={
            "filename": path.name,
            "size_bytes": path.stat().st_size,
            "content_type": content_type,
            "type": kind,
        }
        | extra,
        headers=csrf_headers(client),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    put = httpx.put(body["upload_url"], content=path.read_bytes(), headers={"Content-Type": content_type})
    assert put.status_code == 200
    done = client.post(f"/api/v1/assets/{body['asset']['id']}/complete", headers=csrf_headers(client))
    assert done.status_code == 202, done.text
    return done.json()["asset"]


@needs_media
def test_broll_e_efeito_sonoro_ficam_prontos_com_duracao_e_miniatura(client, outbox, tmp_path):
    make_user(client, outbox)
    clip = make_media(tmp_path, "praia.mp4", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3")
    beep = make_media(tmp_path, "whoosh.mp3", "-f", "lavfi", "-i", "sine=frequency=880:duration=1")

    video = send(client, clip, "video", "video/mp4", tags=["#Praia", "verão", "praia"])
    sfx = send(client, beep, "sfx", "audio/mpeg", name="Whoosh curto", category="Transições")
    assert video["status"] == "processing" and video["tags"] == ["praia", "verão"]
    assert drain(client, tmp_path) == ["done", "done"]

    listing = client.get("/api/v1/assets").json()
    by_name = {a["name"]: a for a in listing["items"]}
    broll, whoosh = by_name["praia"], by_name["Whoosh curto"]
    assert broll["status"] == "ready" and broll["width"] == 640 and broll["fps"] == 30
    assert broll["thumb_url"] and round(broll["duration_s"]) == 3
    assert whoosh["thumb_url"] is None and whoosh["width"] is None and whoosh["duration_s"] > 0.5
    assert listing["counts"]["all"] == 2 and listing["counts"]["sfx"] == 1
    assert "Transições" in listing["categories"]

    # Busca por tag, filtro por tipo; uso conta e vira "em alta" com 3 usos na semana.
    assert [a["id"] for a in client.get("/api/v1/assets", params={"q": "praia"}).json()["items"]] == [
        broll["id"]
    ]
    assert [a["type"] for a in client.get("/api/v1/assets", params={"type": "sfx"}).json()["items"]] == [
        "sfx"
    ]
    for _ in range(3):
        used = client.post(f"/api/v1/assets/{sfx['id']}/use", headers=csrf_headers(client)).json()["asset"]
    assert used["usage_count"] == 3 and used["trending"] is True

    # O arquivo conta no espaço do plano.
    assert client.get("/api/v1/usage").json()["usage"]["storage_used_bytes"] >= clip.stat().st_size
    media = client.get(f"/api/v1/assets/{broll['id']}/media/file", follow_redirects=False)
    assert media.status_code == 302

    assert client.delete(f"/api/v1/assets/{broll['id']}", headers=csrf_headers(client)).json() == {"ok": True}
    assert client.get(f"/api/v1/assets/{broll['id']}").status_code == 404


def test_formato_errado_para_o_tipo_e_recusado(client, outbox):
    make_user(client, outbox)
    resp = client.post(
        "/api/v1/assets/uploads",
        json={"filename": "musica.mp4", "size_bytes": 10, "content_type": "video/mp4", "type": "audio"},
        headers=csrf_headers(client),
    )
    assert resp.status_code == 415


def test_modelos_iniciais_padrao_unico_e_duplicar(client, outbox):
    make_user(client, outbox)
    items = client.get("/api/v1/templates").json()["items"]
    assert len(items) == 4 and [t["is_default"] for t in items].count(True) == 1
    # Listar de novo não semeia outra vez.
    assert len(client.get("/api/v1/templates").json()["items"]) == 4

    second = items[1]["id"]
    client.post(f"/api/v1/templates/{second}/default", headers=csrf_headers(client))
    items = client.get("/api/v1/templates").json()["items"]
    assert items[0]["id"] == second and [t["is_default"] for t in items].count(True) == 1

    copy = client.post(f"/api/v1/templates/{second}/duplicate", headers=csrf_headers(client)).json()[
        "template"
    ]
    assert copy["name"].endswith("(cópia)") and not copy["is_default"]
    resp = client.patch(
        f"/api/v1/templates/{copy['id']}",
        json={
            "name": "Meu verde",
            "caption": {"preset": "destaque", "highlight": "#00FF88"},
            "pacing": "ultra",
        },
        headers=csrf_headers(client),
    )
    edited = resp.json()["template"]
    assert edited["caption"]["highlight"] == "#00FF88" and edited["cut_seconds"] == 1.5

    # Apagar o padrão promove outro.
    client.delete(f"/api/v1/templates/{second}", headers=csrf_headers(client))
    items = client.get("/api/v1/templates").json()["items"]
    assert len(items) == 4 and [t["is_default"] for t in items].count(True) == 1
    assert (
        client.post(
            "/api/v1/templates", json={"name": "x", "accent": "azul"}, headers=csrf_headers(client)
        ).status_code
        == 422
    )

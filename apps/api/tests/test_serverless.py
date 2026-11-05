"""Vercel: FFmpeg sem ffprobe, worker em fatias (para no meio e continua) e as rotas pump/cron."""

import asyncio
import shutil
import subprocess

import pytest
from conftest import csrf_headers, make_user

from clipo_api import worker
from clipo_api.core.config import get_settings
from clipo_api.services import jobs, media, processing


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="precisa do FFmpeg")
def test_le_video_sem_ffprobe(tmp_path, monkeypatch):
    path = tmp_path / "v.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=25:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-shortest",
            str(path),
        ],
        check=True,
    )
    monkeypatch.setattr(media, "ffprobe_bin", lambda: None)
    info = asyncio.run(media.probe(path))
    assert round(info.duration) == 2 and info.width == 320 and info.height == 240 and info.has_audio
    extra = asyncio.run(media.probe_any(path))
    assert extra["fps"] == 25 and extra["has_video"]


@pytest.fixture
def serverless(monkeypatch):
    monkeypatch.setenv("SERVERLESS", "true")
    monkeypatch.setenv("CRON_SECRET", "segredo-do-cron-de-teste")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def db(client):
    return client.app.state.mongo[get_settings().mongodb_db]


def test_job_para_no_meio_e_continua_sem_contar_tentativa(client, outbox, monkeypatch):
    make_user(client, outbox)
    me = client.get("/api/me").json()["user"]["id"]
    calls: list[str] = []

    async def half_then_done(ctx):
        if not ctx.state.get("half"):
            await ctx.progress(50, "Metade", half=True)
            calls.append("primeira metade")
            raise processing.Yield
        calls.append("segunda metade")
        return {"ok": True}

    monkeypatch.setitem(processing.HANDLERS, "asset.process", half_then_done)
    job = client.portal.call(jobs.enqueue, db(client), "asset.process", me, {"asset_id": "x"})
    out = client.portal.call(lambda: worker.run_slice(db(client), budget=60))
    assert out["outcomes"] == ["yielded", "done"] and calls == ["primeira metade", "segunda metade"]
    final = client.portal.call(db(client).jobs.find_one, {"_id": job["_id"]})
    assert final["status"] == "done" and final["attempts"] == 1 and final["state"]["half"] is True


def test_pump_so_age_na_vercel_e_cron_exige_segredo(client, outbox, monkeypatch, serverless):
    make_user(client, outbox)
    ran: list[str] = []

    async def done(ctx):
        ran.append(ctx.job["_id"])
        return {}

    monkeypatch.setitem(processing.HANDLERS, "asset.process", done)
    me = client.get("/api/me").json()["user"]["id"]
    client.portal.call(jobs.enqueue, db(client), "asset.process", me, {"asset_id": "x"})
    resp = client.post("/api/v1/jobs/pump", headers=csrf_headers(client)).json()
    assert resp["mode"] == "serverless" and resp["ran"] == 1 and resp["active"] == 0 and len(ran) == 1

    assert client.get("/api/v1/internal/cron").status_code == 401
    assert client.get("/api/v1/internal/cron", headers={"Authorization": "Bearer errado"}).status_code == 401
    ok = client.get("/api/v1/internal/cron", headers={"Authorization": "Bearer segredo-do-cron-de-teste"})
    assert ok.status_code == 200 and ok.json()["mode"] == "serverless"


def test_pump_nao_faz_nada_com_worker_de_verdade(client, outbox):
    make_user(client, outbox)
    assert client.post("/api/v1/jobs/pump", headers=csrf_headers(client)).json() == {
        "mode": "worker",
        "ran": 0,
    }


def test_make_admin_promove_conta_existente(client, outbox):
    from clipo_api import make_admin

    make_user(client, outbox)
    assert (
        client.portal.call(make_admin.promote, db(client), "ANA@example.com", "super_admin") == "confirmado"
    )
    assert client.portal.call(make_admin.promote, db(client), "ninguem@example.com", "admin") is None
    user = client.portal.call(db(client).users.find_one, {"email": "ana@example.com"})
    assert user["role"] == "super_admin"

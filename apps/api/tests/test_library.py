"""F3: envio em partes com retomada, cotas, worker com fila, cortes, cancelamento, lixeira e SSE.

Usa o S3 e o FFmpeg locais de verdade; o worker roda dentro do teste.
"""

import json
import shutil
import subprocess
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from conftest import S3_AVAILABLE, csrf_headers, make_user

from clipo_api import worker
from clipo_api.core import plans
from clipo_api.services import jobs, processing, storage

pytestmark = pytest.mark.skipif(
    not S3_AVAILABLE or shutil.which("ffmpeg") is None, reason="precisa do S3 local e do FFmpeg"
)


@pytest.fixture(scope="session")
def video_file(tmp_path_factory) -> Path:
    """Vídeo de 30 s com bitrate alto: passa de 8 MB e vira um envio em várias partes."""
    path = tmp_path_factory.mktemp("videos") / "aula.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=30:duration=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=30",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-b:v",
            "4M",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
        check=True,
    )
    assert path.stat().st_size > storage.MIN_PART_BYTES
    return path


def h(client) -> dict:
    return csrf_headers(client)


def start_upload(client, path: Path) -> dict:
    resp = client.post(
        "/api/v1/uploads",
        json={"filename": path.name, "content_type": "video/mp4", "size_bytes": path.stat().st_size},
        headers=h(client),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["upload"]


def send_parts(client, upload: dict, path: Path, numbers: list[int]) -> None:
    urls = client.post(
        f"/api/v1/uploads/{upload['id']}/parts", json={"part_numbers": numbers}, headers=h(client)
    )
    data = path.read_bytes()
    for item in urls.json()["urls"]:
        n = item["part_number"]
        chunk = data[(n - 1) * upload["part_size"] : n * upload["part_size"]]
        assert httpx.put(item["url"], content=chunk).status_code == 200


def upload_video(client, path: Path, title: str = "Aula 1") -> dict:
    upload = start_upload(client, path)
    send_parts(client, upload, path, list(range(1, upload["parts_count"] + 1)))
    resp = client.post(f"/api/v1/uploads/{upload['id']}/complete", json={"title": title}, headers=h(client))
    assert resp.status_code == 200, resp.text
    return resp.json()["video"]


def drain(client, tmp_path: Path) -> list[str]:
    """Roda o worker até a fila esvaziar. Devolve o estado final de cada job."""
    db = client.app.state.db

    async def run() -> list[str]:
        outcomes = []
        while job := await jobs.claim(db, "worker-teste"):
            outcomes.append(await worker.run_job(db, job, "worker-teste", tmp_path))
        return outcomes

    return client.portal.call(run)


def ready_video(client, path: Path, tmp_path: Path) -> dict:
    video = upload_video(client, path)
    assert drain(client, tmp_path) == ["done"]
    return client.get(f"/api/v1/videos/{video['id']}").json()["video"]


# ---------------------------------------------------------------- envio


def test_envio_em_partes_retoma_depois_de_cair(client, outbox, video_file, tmp_path):
    make_user(client, outbox)
    upload = start_upload(client, video_file)
    assert upload["parts_count"] >= 2

    send_parts(client, upload, video_file, [1])  # a conexão "cai" depois da primeira parte
    status = client.get(f"/api/v1/uploads/{upload['id']}").json()["upload"]
    assert status["uploaded_parts"] == [1]
    early = client.post(f"/api/v1/uploads/{upload['id']}/complete", json={}, headers=h(client))
    assert early.json()["error"]["code"] == "upload_incomplete"

    missing = [n for n in range(1, upload["parts_count"] + 1) if n not in status["uploaded_parts"]]
    send_parts(client, upload, video_file, missing)
    done = client.post(
        f"/api/v1/uploads/{upload['id']}/complete", json={"title": "aula.mp4"}, headers=h(client)
    )
    video = done.json()["video"]
    assert video["status"] == "processing" and video["title"] == "aula"

    assert drain(client, tmp_path) == ["done"]
    ready = client.get(f"/api/v1/videos/{video['id']}").json()["video"]
    assert ready["status"] == "ready"
    assert round(ready["duration_s"]) == 30 and (ready["width"], ready["height"]) == (1280, 720)
    for url in (ready["preview_url"], ready["thumbnail_url"], ready["source_url"]):
        media = client.get(url, follow_redirects=False)
        assert media.status_code == 302 and httpx.get(media.headers["location"]).status_code == 200


def test_arquivo_que_nao_e_video_e_recusado_e_nao_ocupa_cota(client, outbox, tmp_path):
    make_user(client, outbox)
    fake = tmp_path / "falso.mp4"
    fake.write_bytes(b"nao sou um video" * 100)
    video = upload_video(client, fake)
    assert drain(client, tmp_path) == ["failed"]
    after = client.get(f"/api/v1/videos/{video['id']}").json()["video"]
    assert after["status"] == "rejected" and "inválido" in after["error"]
    assert client.get("/api/v1/usage").json()["usage"]["storage_used_bytes"] == 0


# ---------------------------------------------------------------- cotas


BASICO = plans.DEFAULT_PLANS["basico"]
_ALL_PLANS = plans.all_plans


def _set_plan(monkeypatch, **changes):
    """Muda os limites do Básico (o plano do teste de conta nova). Parte sempre do plano original."""

    async def patched(db):
        return {**await _ALL_PLANS(db), "basico": replace(BASICO, **changes)}

    monkeypatch.setattr(plans, "all_plans", patched)


def test_cotas_de_tamanho_espaco_e_vidios_por_mes(client, outbox, video_file, monkeypatch):
    make_user(client, outbox)
    size = video_file.stat().st_size
    body = {"filename": "a.mp4", "content_type": "video/mp4", "size_bytes": size}

    _set_plan(monkeypatch, max_file_bytes=size - 1)
    assert (
        client.post("/api/v1/uploads", json=body, headers=h(client)).json()["error"]["code"]
        == "quota_file_size"
    )

    _set_plan(monkeypatch, storage_bytes=size + 10)
    assert client.post("/api/v1/uploads", json=body, headers=h(client)).status_code == 201
    # O envio em andamento já reserva espaço: um segundo igual não cabe.
    second = client.post("/api/v1/uploads", json=body, headers=h(client))
    assert second.json()["error"]["code"] == "quota_storage"

    _set_plan(monkeypatch, videos_per_month=0)
    assert (
        client.post("/api/v1/uploads", json=body, headers=h(client)).json()["error"]["code"]
        == "quota_monthly_videos"
    )


def test_video_mais_longo_que_o_plano_e_recusado(client, outbox, video_file, tmp_path, monkeypatch):
    make_user(client, outbox)
    _set_plan(monkeypatch, max_duration_seconds=10)
    video = upload_video(client, video_file)
    assert drain(client, tmp_path) == ["failed"]
    after = client.get(f"/api/v1/videos/{video['id']}").json()["video"]
    assert after["status"] == "rejected" and "aceita até" in after["error"]


# ---------------------------------------------------------------- cortes e worker


def test_corte_em_partes(client, outbox, video_file, tmp_path):
    make_user(client, outbox)
    video = ready_video(client, video_file, tmp_path)
    job = client.post(f"/api/v1/videos/{video['id']}/split", json={"segment_seconds": 12}, headers=h(client))
    assert job.status_code == 202
    assert drain(client, tmp_path) == ["done"]
    clips = client.get(f"/api/v1/videos/{video['id']}").json()["clips"]
    assert [c["title"] for c in clips] == ["Aula 1 - Parte 1", "Aula 1 - Parte 2", "Aula 1 - Parte 3"]
    assert [round(c["duration_s"]) for c in clips] == [12, 12, 6]
    assert all(c["status"] == "ready" for c in clips)
    media = client.get(clips[0]["media_url"], follow_redirects=False)
    assert httpx.get(media.headers["location"]).status_code == 200
    usage = client.get("/api/v1/usage").json()["usage"]
    assert usage["storage_used_bytes"] > video["size_bytes"]

    finished = client.get(f"/api/v1/jobs/{job.json()['job']['id']}").json()["job"]
    assert (finished["status"], finished["progress"]) == ("done", 100)


class Crash(Exception):
    """O worker "morre": o handler para no meio e ninguém registra falha nem conclusão."""


def test_worker_que_cai_no_meio_do_corte_nao_perde_o_trabalho(
    client, outbox, video_file, tmp_path, monkeypatch
):
    make_user(client, outbox)
    video = ready_video(client, video_file, tmp_path)
    client.post(f"/api/v1/videos/{video['id']}/split", json={"segment_seconds": 12}, headers=h(client))
    db = client.app.state.db

    real_render = processing._render
    renders: list[str] = []

    async def render_then_die(ctx, src, clip, a, b):
        if renders:
            raise Crash
        renders.append(clip["_id"])
        await real_render(ctx, src, clip, a, b)

    async def die_mid_job():
        job = await jobs.claim(db, "worker-que-cai")
        ctx = processing.JobContext(db=db, job=job, worker_id="worker-que-cai", scratch=tmp_path)
        monkeypatch.setattr(processing, "_render", render_then_die)
        try:
            await processing.split(ctx)  # sem o run_job: como um processo que morreu
        except Crash:
            pass
        return job["_id"]

    job_id = client.portal.call(die_mid_job)
    job = client.portal.call(db.jobs.find_one, {"_id": job_id})
    assert job["status"] == "running"  # ficou "preso" no worker que morreu
    assert client.portal.call(db.clips.count_documents, {"job_id": job_id, "status": "ready"}) == 1

    # O aluguel vence e outro worker pega o job de volta.
    client.portal.call(
        db.jobs.update_one,
        {"_id": job_id},
        {"$set": {"lease_expires_at": datetime.now(UTC) - timedelta(seconds=1)}},
    )

    async def counted(ctx, src, clip, a, b):
        renders.append(clip["_id"])
        await real_render(ctx, src, clip, a, b)

    monkeypatch.setattr(processing, "_render", counted)
    assert drain(client, tmp_path) == ["done"]

    clips = client.portal.call(lambda: db.clips.find({"job_id": job_id}).to_list())
    assert len(clips) == 3 and all(c["status"] == "ready" for c in clips)  # sem cortes duplicados
    assert len(renders) == 3  # a parte 1 não foi renderizada de novo
    assert client.portal.call(db.jobs.find_one, {"_id": job_id})["attempts"] == 2


def test_falha_temporaria_volta_para_a_fila(client, outbox, video_file, tmp_path, monkeypatch):
    make_user(client, outbox)
    upload_video(client, video_file)
    real_download = storage.download
    calls = {"n": 0}

    async def flaky(key, dest):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("S3 fora do ar")
        await real_download(key, dest)

    monkeypatch.setattr(storage, "download", flaky)
    assert drain(client, tmp_path) == ["queued"]
    db = client.app.state.db
    job = client.portal.call(db.jobs.find_one, {"type": "video.ingest"})
    assert job["status"] == "queued" and job["run_at"] > datetime.now(UTC)
    client.portal.call(db.jobs.update_one, {"_id": job["_id"]}, {"$set": {"run_at": datetime.now(UTC)}})
    assert drain(client, tmp_path) == ["done"]


def test_cancelar_na_fila_e_rodando(client, outbox, video_file, tmp_path, monkeypatch):
    make_user(client, outbox)
    video = ready_video(client, video_file, tmp_path)

    queued = client.post(
        f"/api/v1/videos/{video['id']}/split", json={"segment_seconds": 10}, headers=h(client)
    )
    job_id = queued.json()["job"]["id"]
    cancelled = client.post(f"/api/v1/jobs/{job_id}/cancel", headers=h(client)).json()["job"]
    assert cancelled["status"] == "cancelled"
    assert drain(client, tmp_path) == []

    # Rodando: o worker vê o pedido no próximo "batimento" e interrompe.
    monkeypatch.setattr(worker, "HEARTBEAT_SECONDS", 0.05)
    running = client.post(
        f"/api/v1/videos/{video['id']}/split", json={"segment_seconds": 5}, headers=h(client)
    )
    db = client.app.state.db
    client.portal.call(
        db.jobs.update_one, {"_id": running.json()["job"]["id"]}, {"$set": {"cancel_requested": True}}
    )
    assert drain(client, tmp_path) == ["cancelled"]
    leftovers = client.portal.call(
        db.clips.count_documents, {"job_id": running.json()["job"]["id"], "status": {"$ne": "ready"}}
    )
    assert leftovers == 0


# ---------------------------------------------------------------- lixeira, manutenção e acesso


def test_lixeira_restaurar_e_apagar_de_vez(client, outbox, video_file, tmp_path):
    make_user(client, outbox)
    video = ready_video(client, video_file, tmp_path)
    client.post(f"/api/v1/videos/{video['id']}/split", json={"segment_seconds": 15}, headers=h(client))
    drain(client, tmp_path)

    client.delete(f"/api/v1/videos/{video['id']}", headers=h(client))
    assert client.get("/api/v1/videos").json()["items"] == []
    assert [v["id"] for v in client.get("/api/v1/videos", params={"trash": True}).json()["items"]] == [
        video["id"]
    ]
    client.post(f"/api/v1/videos/{video['id']}/restore", headers=h(client))
    assert len(client.get(f"/api/v1/videos/{video['id']}").json()["clips"]) == 2

    client.delete(f"/api/v1/videos/{video['id']}", headers=h(client))
    db = client.app.state.db
    past = datetime.now(UTC) - timedelta(minutes=1)
    client.portal.call(db.videos.update_many, {}, {"$set": {"purge_after": past}})
    client.portal.call(db.clips.update_many, {}, {"$set": {"purge_after": past}})
    source_key = client.portal.call(db.videos.find_one, {"_id": video["id"]})["source_key"]
    assert client.portal.call(worker.purge_trash, db) >= 1
    assert client.portal.call(db.videos.count_documents, {}) == 0
    assert client.portal.call(db.clips.count_documents, {}) == 0
    assert client.portal.call(storage.object_size, source_key) is None
    assert client.get("/api/v1/usage").json()["usage"]["storage_used_bytes"] == 0


def test_envio_abandonado_e_descartado(client, outbox, video_file):
    make_user(client, outbox)
    upload = start_upload(client, video_file)
    db = client.app.state.db
    client.portal.call(
        db.uploads.update_one,
        {"_id": upload["id"]},
        {"$set": {"created_at": datetime.now(UTC) - timedelta(days=2)}},
    )
    assert client.portal.call(worker.abort_stale_uploads, db) == 1
    assert client.get(f"/api/v1/uploads/{upload['id']}").json()["upload"]["status"] == "aborted"
    assert client.get("/api/v1/usage").json()["usage"]["uploading_bytes"] == 0


def test_outro_usuario_nao_ve_nem_corta(client, outbox, video_file, tmp_path):
    make_user(client, outbox, email="ana@example.com")
    video = ready_video(client, video_file, tmp_path)
    client.cookies.clear()
    make_user(client, outbox, email="bia@example.com")
    for method, path in [
        ("GET", f"/api/v1/videos/{video['id']}"),
        ("GET", f"/api/v1/videos/{video['id']}/media/source"),
        ("PATCH", f"/api/v1/videos/{video['id']}"),
        ("DELETE", f"/api/v1/videos/{video['id']}"),
        ("POST", f"/api/v1/videos/{video['id']}/split"),
        ("GET", f"/api/v1/jobs/{video['job_id']}"),
    ]:
        resp = client.request(method, path, json={"segment_seconds": 10, "title": "x"}, headers=h(client))
        assert resp.status_code == 404, (method, path, resp.status_code)


def test_andamento_por_sse(client, outbox, video_file, tmp_path):
    make_user(client, outbox)
    video = upload_video(client, video_file)
    drain(client, tmp_path)
    with client.stream("GET", f"/api/v1/jobs/{video['job_id']}/events") as resp:
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = "".join(resp.iter_text())
    data = json.loads(body.split("data: ", 1)[1].split("\n", 1)[0])
    assert (data["status"], data["progress"]) == ("done", 100)


def test_editar_titulo_e_tags(client, outbox, video_file, tmp_path):
    make_user(client, outbox)
    video = ready_video(client, video_file, tmp_path)
    resp = client.patch(
        f"/api/v1/videos/{video['id']}",
        json={"title": "Aula de Python", "tags": ["#python", "Python", "aula"]},
        headers=h(client),
    )
    edited = resp.json()["video"]
    assert edited["title"] == "Aula de Python" and edited["tags"] == ["python", "aula"]


def test_forma_de_onda_do_audio_fica_guardada(client, outbox, video_file, tmp_path):
    make_user(client, outbox)
    video = ready_video(client, video_file, tmp_path)
    peaks = client.get(f"/api/v1/videos/{video['id']}/waveform").json()["peaks"]
    assert len(peaks) >= 300 and max(peaks) == 1.0 and min(peaks) >= 0
    # Segunda chamada vem do banco, igual.
    assert client.get(f"/api/v1/videos/{video['id']}/waveform").json()["peaks"] == peaks

"""FFmpeg e ffprobe, sempre como processo com lista de argumentos: nunca passa por um shell.

Nenhum valor vindo do usuário entra na linha de comando como texto; só caminhos de arquivos
temporários criados aqui e números já validados.
"""

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("clipo.media")

PROBE_TIMEOUT = 120
THUMB_TIMEOUT = 60


class MediaError(RuntimeError):
    """Arquivo que não é um vídeo válido, ou FFmpeg que falhou."""


@dataclass(frozen=True)
class Probe:
    duration: float
    has_audio: bool
    width: int | None
    height: int | None


def ffmpeg_bin() -> str:
    """FFmpeg do sistema; sem ele (Vercel), o binário que vem no pacote imageio-ffmpeg."""
    found = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def ffprobe_bin() -> str | None:
    return os.environ.get("FFPROBE_BIN") or shutil.which("ffprobe")


async def _probe_json(path: Path | str) -> dict[str, Any]:
    """Mesmo formato do ffprobe -of json. Sem ffprobe, lê a saída do `ffmpeg -i`."""
    probe_bin = ffprobe_bin()
    if probe_bin:
        out = await _run(
            [
                probe_bin,
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_type,codec_name,width,height,duration,avg_frame_rate",
                "-of",
                "json",
                str(path),
            ],
            PROBE_TIMEOUT,
        )
        try:
            return json.loads(out or b"{}")
        except json.JSONDecodeError as exc:
            raise MediaError("Não foi possível ler este arquivo.") from exc
    return await _probe_with_ffmpeg(path)


async def _probe_with_ffmpeg(path: Path | str) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        ffmpeg_bin(),
        "-hide_banner",
        "-i",
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout=PROBE_TIMEOUT)
    except TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise MediaError("O processamento demorou demais e foi interrompido.") from exc
    text = err.decode(errors="replace")
    data: dict[str, Any] = {"format": {}, "streams": []}
    dur = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if dur:
        h, m, sec = dur.groups()
        data["format"]["duration"] = str(int(h) * 3600 + int(m) * 60 + float(sec))
    for line in text.splitlines():
        kind = re.search(r"Stream #\S+.*?: (Video|Audio): (\w+)", line)
        if not kind:
            continue
        stream: dict[str, Any] = {"codec_type": kind.group(1).lower(), "codec_name": kind.group(2)}
        if stream["codec_type"] == "video":
            size = re.search(r", (\d{2,5})x(\d{2,5})[\s,\[]", line)
            if size:
                stream["width"], stream["height"] = int(size.group(1)), int(size.group(2))
            fps = re.search(r"(\d+(?:\.\d+)?) fps", line)
            if fps:
                stream["avg_frame_rate"] = f"{float(fps.group(1))}/1"
        data["streams"].append(stream)
    if not data["streams"]:
        raise MediaError("Não foi possível ler este arquivo.")
    return data


async def _run(args: list[str], timeout: float, on_start=None) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    if on_start:
        on_start(proc)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise MediaError("O processamento demorou demais e foi interrompido.") from exc
    if proc.returncode != 0:
        # O detalhe vai para o log; o usuário recebe uma mensagem simples.
        log.warning("ffmpeg falhou", extra={"path": args[0]})
        log.debug(stderr.decode(errors="replace")[-2000:])
        raise MediaError("Não foi possível processar este arquivo.")
    return stdout


async def run_ffmpeg(
    args: list[str], *, timeout: float, total_seconds: float, on_start=None, on_progress=None
) -> None:
    """Roda o FFmpeg lendo o `-progress` dele para informar o andamento de 0 a 1."""
    full = [ffmpeg_bin(), "-hide_banner", "-nostats", "-progress", "pipe:1", *args]
    proc = await asyncio.create_subprocess_exec(
        *full, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    if on_start:
        on_start(proc)

    async def read_progress() -> None:
        if proc.stdout is None:  # sempre existe com PIPE; checagem para o tipo
            return
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").strip()
            if line.startswith("out_time_us=") and on_progress and total_seconds > 0:
                try:
                    done = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                await on_progress(min(1.0, max(0.0, done / total_seconds)))

    async def read_errors() -> bytes:
        if proc.stderr is None:
            return b""
        return await proc.stderr.read()

    try:
        _, stderr = await asyncio.wait_for(asyncio.gather(read_progress(), read_errors()), timeout=timeout)
        await proc.wait()
    except TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise MediaError("O processamento demorou demais e foi interrompido.") from exc
    if proc.returncode != 0:
        log.warning("ffmpeg falhou", extra={"path": "ffmpeg"})
        log.debug(stderr.decode(errors="replace")[-2000:])
        raise MediaError("Não foi possível processar este arquivo.")


async def probe(path: Path) -> Probe:
    data = await _probe_json(path)
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError("O arquivo não tem uma faixa de vídeo válida.")
    try:
        duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    if duration <= 0:
        raise MediaError("Não foi possível identificar a duração do vídeo.")
    return Probe(
        duration=duration,
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        width=video.get("width"),
        height=video.get("height"),
    )


async def probe_any(path: Path) -> dict[str, Any]:
    """Para ativos da biblioteca: aceita áudio puro e imagem, além de vídeo."""
    data = await _probe_json(path)
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None and audio is None:
        raise MediaError("O arquivo não tem áudio nem imagem.")
    try:
        duration = float(data.get("format", {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    fps = None
    if video and video.get("avg_frame_rate") not in (None, "0/0"):
        num, _, den = video["avg_frame_rate"].partition("/")
        with contextlib.suppress(ValueError, ZeroDivisionError):
            fps = round(float(num) / float(den or 1))
    return {
        "duration_s": duration if duration > 0 else None,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": fps if fps and fps < 240 else None,
        "has_audio": audio is not None,
        "has_video": video is not None,
    }


async def thumbnail(src: Path, dest: Path, at_seconds: float) -> bool:
    """Gera a miniatura. Falhar aqui não impede o envio do vídeo."""
    try:
        await _run(
            [
                ffmpeg_bin(),
                "-y",
                "-ss",
                f"{max(0.0, at_seconds):.2f}",
                "-i",
                str(src),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(dest),
            ],
            THUMB_TIMEOUT,
        )
    except MediaError:
        return False
    return dest.exists() and dest.stat().st_size > 0


QUALITY_CRF = {"small": "28", "balanced": "23", "high": "18"}


def export_args(export: dict[str, Any] | None) -> list[str]:
    """Preset de exportação do workspace: altura máxima (nunca amplia), fps e qualidade."""
    export = export or {}
    filters = []
    if export.get("max_height"):
        filters.append(f"scale=-2:'min(ih,{int(export['max_height'])})'")
    if export.get("fps"):
        filters.append(f"fps={int(export['fps'])}")
    args = ["-vf", ",".join(filters)] if filters else []
    return [*args, "-crf", QUALITY_CRF.get(export.get("quality", "balanced"), "23")]


async def cut(
    src: Path,
    dest: Path,
    start: float,
    length: float,
    on_start=None,
    on_progress=None,
    export: dict[str, Any] | None = None,
) -> None:
    """Corta um trecho em H.264/AAC pronto para redes sociais."""
    await run_ffmpeg(
        [
            "-y",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(src),
            "-t",
            f"{length:.3f}",
            *export_args(export),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-map_metadata",
            "-1",
            "-movflags",
            "+faststart",
            str(dest),
        ],
        timeout=max(120.0, length * 6),
        total_seconds=length,
        on_start=on_start,
        on_progress=on_progress,
    )


async def preview(src: Path, dest: Path, duration: float, on_start=None, on_progress=None) -> None:
    """Versão leve (até 480p) para tocar na tela sem baixar o original inteiro."""
    await run_ffmpeg(
        [
            "-y",
            "-i",
            str(src),
            "-vf",
            "scale=-2:'min(480,ih)'",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            str(dest),
        ],
        timeout=max(180.0, duration * 4),
        total_seconds=duration,
        on_start=on_start,
        on_progress=on_progress,
    )


def format_duration(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 60}:{total % 60:02d}"


def format_size(size: int) -> str:
    if size <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f} {unit}".replace(".0 ", " ")
        value /= 1024
    return f"{size} B"


_ASS: bool | None = None


async def can_burn_subtitles() -> bool:
    """O FFmpeg precisa ter a libass (filtro "ass") para gravar legendas no vídeo."""
    global _ASS
    if _ASS is None:
        out = await _run([ffmpeg_bin(), "-hide_banner", "-filters"], PROBE_TIMEOUT)
        _ASS = any(
            line.split()[1:2] == ["ass"] for line in out.decode(errors="ignore").splitlines() if line.strip()
        )
    return _ASS


WAVEFORM_POINTS = 400
WAVEFORM_RATE = 400  # amostras por segundo para o desenho: suficiente para ver fala e pausas


async def waveform(source: str, duration: float) -> list[float]:
    """Picos do áudio (0 a 1) em WAVEFORM_POINTS colunas, para a linha do tempo do editor."""
    raw = await _run(
        [
            ffmpeg_bin(),
            "-v",
            "error",
            "-i",
            source,
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(WAVEFORM_RATE),
            "-f",
            "s16le",
            "-",
        ],
        max(60.0, duration / 20),
    )
    import array

    samples = array.array("h")
    samples.frombytes(raw[: len(raw) - len(raw) % 2])
    if not samples:
        return []
    size = max(1, len(samples) // WAVEFORM_POINTS)
    peaks = [max(abs(v) for v in samples[i : i + size]) for i in range(0, len(samples), size)][
        :WAVEFORM_POINTS
    ]
    top = max(peaks) or 1
    return [round(v / top, 3) for v in peaks]

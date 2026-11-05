"""Arquivos em armazenamento compatível com S3 (SeaweedFS em desenvolvimento; S3 ou R2 em produção).

Todo objeto fica sob `users/<user_id>/`. A API nunca recebe o arquivo: o navegador envia e baixa
direto do bucket por URLs assinadas de curta duração.
"""

import asyncio
import re
from functools import lru_cache
from pathlib import Path
from uuid import uuid4

import boto3
from botocore.client import BaseClient
from botocore.config import Config
from botocore.exceptions import ClientError

from clipo_api.core.config import get_settings

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class StorageNotConfigured(RuntimeError):
    pass


def _client(endpoint: str | None) -> BaseClient:
    settings = get_settings()
    if not (settings.s3_access_key_id and settings.s3_secret_access_key):
        raise StorageNotConfigured("S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY não definidos")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


@lru_cache
def internal_client() -> BaseClient:
    """Fala com o bucket pela rede interna (ex.: http://minio:9000 dentro do Docker)."""
    return _client(get_settings().s3_endpoint_url)


@lru_cache
def signing_client() -> BaseClient:
    """Assina URLs com o endereço público: a assinatura inclui o host que o navegador vai usar."""
    settings = get_settings()
    return _client(settings.s3_public_endpoint_url or settings.s3_endpoint_url)


def user_prefix(user_id: str) -> str:
    return f"users/{user_id}/"


def new_object_key(user_id: str, folder: str, filename: str) -> str:
    name = _SAFE_NAME.sub("_", filename).strip("._")[:120] or "arquivo"
    return f"{user_prefix(user_id)}{folder}/{uuid4().hex}-{name}"


def owns_key(user_id: str, key: str) -> bool:
    return key.startswith(user_prefix(user_id)) and ".." not in key and "//" not in key


def presign_upload(key: str, content_type: str) -> str:
    settings = get_settings()
    return signing_client().generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.s3_bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=settings.s3_url_expires_seconds,
    )


def internal_url(key: str, seconds: int = 900) -> str:
    """URL assinada pela rede interna, para o FFmpeg do servidor ler o arquivo sem baixar antes."""
    settings = get_settings()
    return internal_client().generate_presigned_url(
        "get_object", Params={"Bucket": settings.s3_bucket, "Key": key}, ExpiresIn=seconds
    )


def presign_download(key: str) -> str:
    settings = get_settings()
    return signing_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": key},
        ExpiresIn=settings.s3_url_expires_seconds,
    )


async def delete_object(key: str) -> None:
    await asyncio.to_thread(internal_client().delete_object, Bucket=get_settings().s3_bucket, Key=key)


async def object_size(key: str) -> int | None:
    """Tamanho em bytes, ou None se o objeto não existe."""
    try:
        head = await asyncio.to_thread(
            internal_client().head_object, Bucket=get_settings().s3_bucket, Key=key
        )
    except ClientError:
        return None
    return int(head["ContentLength"])


async def download(key: str, dest: Path) -> None:
    await asyncio.to_thread(internal_client().download_file, get_settings().s3_bucket, key, str(dest))


async def upload(src: Path, key: str, content_type: str) -> None:
    await asyncio.to_thread(
        internal_client().upload_file,
        str(src),
        get_settings().s3_bucket,
        key,
        ExtraArgs={"ContentType": content_type},
    )


async def read_bytes(key: str, max_bytes: int) -> bytes | None:
    """Lê um objeto pequeno (ex.: miniatura). None se não existe ou passa do limite."""
    size = await object_size(key)
    if size is None or size > max_bytes:
        return None
    obj = await asyncio.to_thread(internal_client().get_object, Bucket=get_settings().s3_bucket, Key=key)
    return await asyncio.to_thread(obj["Body"].read)


async def read_range(key: str, start: int, end: int) -> bytes:
    """Lê só o trecho [start, end] do objeto, sem carregar o arquivo inteiro na memória."""
    obj = await asyncio.to_thread(
        internal_client().get_object, Bucket=get_settings().s3_bucket, Key=key, Range=f"bytes={start}-{end}"
    )
    return await asyncio.to_thread(obj["Body"].read)


# ---------------------------------------------------------------- envio em partes (multipart)

MIN_PART_BYTES = 8 * 1024 * 1024
MAX_PARTS = 10_000


def part_size_for(size_bytes: int) -> int:
    """Partes de 8 MB, ou maiores se o arquivo passaria de 10 mil partes (limite do S3)."""
    needed = -(-size_bytes // MAX_PARTS)
    mb = 1024 * 1024
    return max(MIN_PART_BYTES, -(-needed // mb) * mb)


async def create_multipart(key: str, content_type: str) -> str:
    resp = await asyncio.to_thread(
        internal_client().create_multipart_upload,
        Bucket=get_settings().s3_bucket,
        Key=key,
        ContentType=content_type,
    )
    return resp["UploadId"]


def presign_part(key: str, upload_id: str, part_number: int) -> str:
    settings = get_settings()
    return signing_client().generate_presigned_url(
        "upload_part",
        Params={"Bucket": settings.s3_bucket, "Key": key, "UploadId": upload_id, "PartNumber": part_number},
        ExpiresIn=settings.s3_url_expires_seconds * 4,
    )


async def list_parts(key: str, upload_id: str) -> list[dict]:
    """Partes já recebidas pelo S3: é daqui que sai a retomada de um envio interrompido."""
    client = internal_client()
    bucket = get_settings().s3_bucket
    parts: list[dict] = []
    marker = 0
    while True:
        page = await asyncio.to_thread(
            client.list_parts,
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            PartNumberMarker=marker,
            MaxParts=1000,
        )
        parts.extend(
            {"PartNumber": p["PartNumber"], "ETag": p["ETag"], "Size": p["Size"]}
            for p in page.get("Parts", [])
        )
        if not page.get("IsTruncated"):
            return parts
        marker = page["NextPartNumberMarker"]


async def complete_multipart(key: str, upload_id: str, parts: list[dict]) -> None:
    await asyncio.to_thread(
        internal_client().complete_multipart_upload,
        Bucket=get_settings().s3_bucket,
        Key=key,
        UploadId=upload_id,
        MultipartUpload={"Parts": [{"PartNumber": p["PartNumber"], "ETag": p["ETag"]} for p in parts]},
    )


async def abort_multipart(key: str, upload_id: str) -> None:
    try:
        await asyncio.to_thread(
            internal_client().abort_multipart_upload,
            Bucket=get_settings().s3_bucket,
            Key=key,
            UploadId=upload_id,
        )
    except ClientError:
        pass


async def delete_prefix(prefix: str) -> int:
    """Apaga todos os objetos sob um prefixo (ex.: tudo de um usuário). Devolve quantos apagou."""
    if not prefix.startswith("users/") or len(prefix) < len("users/x/"):
        raise ValueError("prefixo de exclusão inseguro")
    client = internal_client()
    bucket = get_settings().s3_bucket
    total = 0
    token: str | None = None
    while True:
        kwargs: dict = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        page = await asyncio.to_thread(client.list_objects_v2, **kwargs)
        keys = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
        if keys:
            await asyncio.to_thread(
                client.delete_objects, Bucket=bucket, Delete={"Objects": keys, "Quiet": True}
            )
            total += len(keys)
        if not page.get("IsTruncated"):
            return total
        token = page.get("NextContinuationToken")


MEDIA_PREFIX = "/media/"


def media_url(key: str) -> str:
    """Endereço estável que as telas guardam. A API troca por uma URL assinada a cada acesso."""
    return f"{MEDIA_PREFIX}{key}"


def key_from_media_url(url: str | None) -> str | None:
    if not url:
        return None
    path = url.split("?", 1)[0]
    if "://" in path:
        path = "/" + path.split("://", 1)[1].split("/", 1)[-1]
    return path[len(MEDIA_PREFIX) :] if path.startswith(MEDIA_PREFIX) else None


def _ensure_bucket_sync() -> None:
    client = internal_client()
    bucket = get_settings().s3_bucket
    try:
        client.head_bucket(Bucket=bucket)
    except ClientError:
        client.create_bucket(Bucket=bucket)


async def ensure_bucket() -> None:
    """Só em desenvolvimento: em produção o bucket é criado e configurado fora da aplicação."""
    await asyncio.to_thread(_ensure_bucket_sync)

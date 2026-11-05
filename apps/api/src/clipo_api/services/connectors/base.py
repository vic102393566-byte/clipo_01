"""Formato comum dos conectores de redes sociais.

Cada rede implementa a mesma interface: conectar (OAuth), renovar o token, ler a conta, enviar e
publicar um vídeo, consultar o status e, quando a API da rede permite, apagar. Toda chamada passa
pelo cliente HTTP com log (`LoggedClient`), então cada uma fica registrada no log do sistema.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import httpx

from clipo_api.observability.http import LoggedClient

Platform = Literal["youtube", "instagram", "tiktok"]

# Os testes trocam o transporte para simular as redes sem rede de verdade.
HTTP_TRANSPORT: httpx.AsyncBaseTransport | None = None


class ConnectorError(Exception):
    """Falha ao falar com a rede. `code` é estável (vai para a tela); `message`, para pessoas."""

    def __init__(self, code: str, message: str, *, retryable: bool = False, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status = status


class ReconnectRequired(ConnectorError):
    """O token não vale mais (revogado ou vencido de vez): a pessoa precisa conectar de novo."""

    def __init__(self, message: str = "A conexão expirou. Conecte a conta de novo."):
        super().__init__("reconnect_required", message)


class NotSupported(ConnectorError):
    def __init__(self, message: str):
        super().__init__("not_supported", message)


@dataclass
class TokenSet:
    access_token: str
    refresh_token: str | None = None
    expires_at: datetime | None = None
    refresh_expires_at: datetime | None = None
    scope: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def expiry(seconds: Any) -> datetime | None:
        try:
            return datetime.now(UTC) + timedelta(seconds=int(seconds))
        except (TypeError, ValueError):
            return None

    def secrets(self) -> dict[str, Any]:
        return {"access_token": self.access_token, "refresh_token": self.refresh_token, **self.extra}


@dataclass
class Account:
    id: str
    name: str
    handle: str
    avatar_url: str | None = None
    followers: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "handle": self.handle,
            "avatar_url": self.avatar_url,
            "followers": self.followers,
            **self.extra,
        }


@dataclass
class VideoUpload:
    path: Path
    size: int
    title: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    # private/unlisted/public no YouTube; SELF_ONLY/PUBLIC_TO_EVERYONE... no TikTok
    privacy: str = "private"
    draft: bool = False


@dataclass
class UploadResult:
    remote_id: str
    status: str
    url: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class PostMetrics:
    """Totais acumulados de uma publicação. None = a rede não informa."""

    views: int
    likes: int | None = None
    comments: int | None = None
    shares: int | None = None
    saves: int | None = None
    avg_view_s: float | None = None
    retention_pct: float | None = None


class Connector(ABC):
    platform: Platform
    label: str
    scopes: str
    supports_delete: bool = False
    delete_note: str = ""

    def client(self) -> LoggedClient:
        return LoggedClient(platform=self.platform, transport=HTTP_TRANSPORT, timeout=httpx.Timeout(60.0))

    @abstractmethod
    def configured(self) -> bool: ...

    @abstractmethod
    def authorize_url(self, state: str, redirect_uri: str, code_challenge: str | None) -> str: ...

    @abstractmethod
    async def exchange_code(self, code: str, redirect_uri: str, code_verifier: str | None) -> TokenSet: ...

    @abstractmethod
    async def refresh(self, tokens: dict[str, Any]) -> TokenSet: ...

    @abstractmethod
    async def account(self, tokens: dict[str, Any]) -> Account: ...

    @abstractmethod
    async def upload(
        self, tokens: dict[str, Any], account: dict[str, Any], video: VideoUpload
    ) -> UploadResult: ...

    @abstractmethod
    async def status(
        self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str
    ) -> UploadResult: ...

    async def delete(self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str) -> None:
        raise NotSupported(self.delete_note or f"A API do {self.label} não permite apagar publicações.")

    async def metrics(self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str) -> PostMetrics:
        raise NotSupported(f"A API do {self.label} não informa métricas desta publicação.")

    async def followers(self, tokens: dict[str, Any], account: dict[str, Any]) -> int:
        raise NotSupported(f"A API do {self.label} não informa seguidores.")

    async def revoke(self, tokens: dict[str, Any]) -> None:  # noqa: B027 — opcional por rede
        """Revoga o acesso na rede ao desconectar, quando a rede oferece isso."""


def check_response(resp: httpx.Response, what: str) -> dict[str, Any]:
    """Traduz respostas de erro das redes para ConnectorError com o motivo."""
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if resp.status_code == 401:
        raise ReconnectRequired()
    if resp.status_code >= 400:
        err = data.get("error") if isinstance(data, dict) else None
        message = (
            (err.get("message") if isinstance(err, dict) else err)
            or data.get("error_description")
            or f"{what} falhou (HTTP {resp.status_code})"
        )
        raise ConnectorError(
            "provider_error",
            f"{what}: {message}",
            retryable=resp.status_code >= 500 or resp.status_code == 429,
            status=resp.status_code,
        )
    return data if isinstance(data, dict) else {}

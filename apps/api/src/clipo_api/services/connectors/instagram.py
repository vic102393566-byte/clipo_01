"""Instagram (Graph API, conta profissional ligada a uma página do Facebook).

Envio de Reels pelo envio retomável da Meta (o arquivo vai direto, sem precisar de URL pública).
A API do Instagram não permite apagar publicações nem publicar como privado.
"""

import asyncio
from typing import Any
from urllib.parse import urlencode

from clipo_api.core.config import get_settings
from clipo_api.services.connectors.base import (
    Account,
    Connector,
    ConnectorError,
    PostMetrics,
    ReconnectRequired,
    TokenSet,
    UploadResult,
    VideoUpload,
)

VERSION = "v21.0"
AUTH_URL = f"https://www.facebook.com/{VERSION}/dialog/oauth"
GRAPH = f"https://graph.facebook.com/{VERSION}"
RUPLOAD = f"https://rupload.facebook.com/ig-api-upload/{VERSION}"
IG_FIELDS = "name,instagram_business_account{id,username,name,profile_picture_url,followers_count}"


class Instagram(Connector):
    platform = "instagram"
    label = "Instagram"
    scopes = (
        "instagram_basic,instagram_content_publish,instagram_manage_insights,pages_show_list,"
        "pages_read_engagement,business_management"
    )
    supports_delete = False
    delete_note = "A API do Instagram não permite apagar publicações. Apague pelo app do Instagram."

    def _creds(self) -> tuple[str | None, str | None]:
        s = get_settings()
        return s.instagram_client_id, s.instagram_client_secret

    def configured(self) -> bool:
        return all(self._creds())

    def authorize_url(self, state: str, redirect_uri: str, code_challenge: str | None) -> str:
        params = {
            "client_id": self._creds()[0],
            "redirect_uri": redirect_uri,
            "scope": self.scopes,
            "response_type": "code",
            "state": state,
        }
        return f"{AUTH_URL}?{urlencode(params)}"

    @staticmethod
    def _check(resp, what: str) -> dict[str, Any]:
        try:
            data = resp.json()
        except ValueError:
            data = {}
        error = data.get("error") if isinstance(data, dict) else None
        if error:
            # 190 = token inválido/vencido; 10 e 200 = permissão retirada.
            if error.get("code") in (190, 10, 200) or resp.status_code == 401:
                raise ReconnectRequired()
            raise ConnectorError(
                f"meta_{error.get('code', 'error')}",
                f"{what}: {error.get('message', 'erro da Meta')}",
                retryable=bool(error.get("is_transient")) or resp.status_code >= 500,
                status=resp.status_code,
            )
        if resp.status_code >= 400:
            raise ConnectorError(
                "provider_error",
                f"{what} falhou (HTTP {resp.status_code})",
                retryable=resp.status_code >= 500,
            )
        return data

    async def _long_lived(self, short_token: str) -> TokenSet:
        client_id, secret = self._creds()
        async with self.client() as http:
            resp = await http.get(
                f"{GRAPH}/oauth/access_token",
                params={
                    "grant_type": "fb_exchange_token",
                    "client_id": client_id,
                    "client_secret": secret,
                    "fb_exchange_token": short_token,
                },
            )
        data = self._check(resp, "Token de longa duração da Meta")
        return TokenSet(access_token=data["access_token"], expires_at=TokenSet.expiry(data.get("expires_in")))

    async def exchange_code(self, code: str, redirect_uri: str, code_verifier: str | None) -> TokenSet:
        client_id, secret = self._creds()
        async with self.client() as http:
            resp = await http.get(
                f"{GRAPH}/oauth/access_token",
                params={
                    "client_id": client_id,
                    "client_secret": secret,
                    "redirect_uri": redirect_uri,
                    "code": code,
                },
            )
        short = self._check(resp, "Token da Meta")["access_token"]
        # O token curto dura 1 h; o longo, cerca de 60 dias.
        return await self._long_lived(short)

    async def refresh(self, tokens: dict[str, Any]) -> TokenSet:
        """A Meta renova trocando o token longo, ainda válido, por outro de mais 60 dias."""
        return await self._long_lived(tokens["access_token"])

    async def account(self, tokens: dict[str, Any]) -> Account:
        async with self.client() as http:
            resp = await http.get(
                f"{GRAPH}/me/accounts",
                params={
                    "fields": IG_FIELDS,
                    "access_token": tokens["access_token"],
                },
            )
        pages = self._check(resp, "Contas do Instagram").get("data") or []
        for page in pages:
            ig = page.get("instagram_business_account")
            if ig:
                return Account(
                    id=ig["id"],
                    name=ig.get("name") or ig.get("username") or page.get("name") or "Instagram",
                    handle=f"@{ig.get('username', '')}",
                    avatar_url=ig.get("profile_picture_url"),
                    followers=ig.get("followers_count"),
                    extra={"page_name": page.get("name")},
                )
        raise ConnectorError(
            "no_business_account",
            "Nenhuma conta profissional do Instagram ligada a uma página do Facebook foi encontrada.",
        )

    async def create_container(
        self, tokens: dict[str, Any], account: dict[str, Any], video: VideoUpload
    ) -> str:
        """Cria o contêiner do Reel e envia o arquivo. Ainda não publica nada."""
        async with self.client() as http:
            resp = await http.post(
                f"{GRAPH}/{account['id']}/media",
                data={
                    "media_type": "REELS",
                    "upload_type": "resumable",
                    "caption": f"{video.title}\n\n{video.description}".strip()[:2200],
                    "share_to_feed": "true",
                    "access_token": tokens["access_token"],
                },
            )
            container = self._check(resp, "Contêiner do Reel")["id"]
            with video.path.open("rb") as f:
                data = f.read()
            up = await http.post(
                f"{RUPLOAD}/{container}",
                content=data,
                headers={
                    "Authorization": f"OAuth {tokens['access_token']}",
                    "offset": "0",
                    "file_size": str(video.size),
                },
            )
            self._check(up, "Envio do Reel")
        return container

    async def container_status(self, tokens: dict[str, Any], container_id: str) -> str:
        async with self.client() as http:
            resp = await http.get(
                f"{GRAPH}/{container_id}",
                params={
                    "fields": "status_code,status",
                    "access_token": tokens["access_token"],
                },
            )
        return self._check(resp, "Status do Reel").get("status_code", "UNKNOWN")

    async def wait_ready(self, tokens: dict[str, Any], container_id: str, max_wait: float = 300) -> str:
        waited = 0.0
        while waited < max_wait:
            status = await self.container_status(tokens, container_id)
            if status in ("FINISHED", "ERROR", "EXPIRED"):
                return status
            await asyncio.sleep(3)
            waited += 3
        return "IN_PROGRESS"

    async def upload(
        self, tokens: dict[str, Any], account: dict[str, Any], video: VideoUpload
    ) -> UploadResult:
        container = await self.create_container(tokens, account, video)
        status = await self.wait_ready(tokens, container)
        if status != "FINISHED":
            raise ConnectorError("processing_failed", f"O Instagram não processou o vídeo (status {status}).")
        async with self.client() as http:
            resp = await http.post(
                f"{GRAPH}/{account['id']}/media_publish",
                data={
                    "creation_id": container,
                    "access_token": tokens["access_token"],
                },
            )
        media_id = self._check(resp, "Publicação do Reel")["id"]
        return UploadResult(remote_id=media_id, status="PUBLISHED", extra={"container_id": container})

    async def status(self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str) -> UploadResult:
        async with self.client() as http:
            resp = await http.get(
                f"{GRAPH}/{remote_id}",
                params={
                    "fields": "id,permalink,media_type",
                    "access_token": tokens["access_token"],
                },
            )
        data = self._check(resp, "Status no Instagram")
        return UploadResult(remote_id=remote_id, status="PUBLISHED", url=data.get("permalink"))

    async def metrics(self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str) -> PostMetrics:
        async with self.client() as http:
            resp = await http.get(
                f"{GRAPH}/{remote_id}/insights",
                params={
                    "metric": "views,likes,comments,shares,saved,ig_reels_avg_watch_time",
                    "access_token": tokens["access_token"],
                },
            )
        data = self._check(resp, "Métricas no Instagram").get("data") or []
        values = {m["name"]: (m.get("values") or [{}])[0].get("value") for m in data}
        avg_ms = values.get("ig_reels_avg_watch_time")
        return PostMetrics(
            views=int(values.get("views") or 0),
            likes=values.get("likes"),
            comments=values.get("comments"),
            shares=values.get("shares"),
            saves=values.get("saved"),
            avg_view_s=avg_ms / 1000 if avg_ms else None,
        )

    async def followers(self, tokens: dict[str, Any], account: dict[str, Any]) -> int:
        async with self.client() as http:
            resp = await http.get(
                f"{GRAPH}/{account['id']}",
                params={"fields": "followers_count", "access_token": tokens["access_token"]},
            )
        return int(self._check(resp, "Seguidores no Instagram").get("followers_count", 0))

    async def revoke(self, tokens: dict[str, Any]) -> None:
        async with self.client() as http:
            await http.delete(f"{GRAPH}/me/permissions", params={"access_token": tokens["access_token"]})


def webhook_signature_valid(header: str, body: bytes, app_secret: str) -> bool:
    """Cabeçalho X-Hub-Signature-256: "sha256=<HMAC-SHA256 do corpo com o app secret>"."""
    import hashlib
    import hmac

    if not header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))

"""TikTok (Content Posting API v2): OAuth, envio para rascunho ou publicação direta, status.

A API do TikTok não tem rota para apagar publicações.
Apps ainda não auditados pelo TikTok só publicam como privado ("só eu", SELF_ONLY).
"""

import secrets
from typing import Any
from urllib.parse import urlencode

from clipo_api.core.config import get_settings
from clipo_api.services.connectors.base import (
    Account,
    Connector,
    ConnectorError,
    ReconnectRequired,
    TokenSet,
    UploadResult,
    VideoUpload,
)

AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/"
API = "https://open.tiktokapis.com/v2"
# Pedaço único até 64 MB; acima disso, pedaços de 10 MB e o último com o resto.
SINGLE_CHUNK_MAX = 64 * 1024 * 1024
CHUNK = 10 * 1024 * 1024


class TikTok(Connector):
    platform = "tiktok"
    label = "TikTok"
    scopes = "user.info.basic,user.info.profile,user.info.stats,video.upload,video.publish"
    supports_delete = False
    delete_note = "A API do TikTok não permite apagar vídeos. Apague pelo app do TikTok."

    def _creds(self) -> tuple[str | None, str | None]:
        s = get_settings()
        return s.tiktok_client_key, s.tiktok_client_secret

    def configured(self) -> bool:
        return all(self._creds())

    def authorize_url(self, state: str, redirect_uri: str, code_challenge: str | None) -> str:
        params = {
            "client_key": self._creds()[0],
            "scope": self.scopes,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "state": state,
        }
        return f"{AUTH_URL}?{urlencode(params)}"

    @staticmethod
    def _check(resp, what: str) -> dict[str, Any]:
        try:
            data = resp.json()
        except ValueError:
            data = {}
        error = data.get("error") or {}
        code = error.get("code") if isinstance(error, dict) else error
        if resp.status_code == 401 or code in ("access_token_invalid", "invalid_grant", "token_expired"):
            raise ReconnectRequired()
        if resp.status_code >= 400 or (code and code != "ok"):
            message = (error.get("message") if isinstance(error, dict) else None) or data.get(
                "error_description"
            )
            raise ConnectorError(
                code or "provider_error",
                f"{what}: {message or f'HTTP {resp.status_code}'}",
                retryable=resp.status_code >= 500 or code == "rate_limit_exceeded",
                status=resp.status_code,
            )
        return data

    async def _token(self, form: dict[str, Any]) -> TokenSet:
        client_key, secret = self._creds()
        async with self.client() as http:
            resp = await http.post(
                f"{API}/oauth/token/",
                data={**form, "client_key": client_key, "client_secret": secret},
                headers={"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"},
            )
        data = self._check(resp, "Token do TikTok")
        data = data.get("data", data)
        if not data.get("access_token"):
            raise ReconnectRequired()
        return TokenSet(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token"),
            expires_at=TokenSet.expiry(data.get("expires_in")),
            refresh_expires_at=TokenSet.expiry(data.get("refresh_expires_in")),
            scope=data.get("scope"),
            extra={"open_id": data.get("open_id")},
        )

    async def exchange_code(self, code: str, redirect_uri: str, code_verifier: str | None) -> TokenSet:
        return await self._token(
            {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri}
        )

    async def refresh(self, tokens: dict[str, Any]) -> TokenSet:
        if not tokens.get("refresh_token"):
            raise ReconnectRequired()
        return await self._token({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})

    def _auth(self, tokens: dict[str, Any]) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {tokens['access_token']}",
            "Content-Type": "application/json; charset=UTF-8",
        }

    async def account(self, tokens: dict[str, Any]) -> Account:
        async with self.client() as http:
            resp = await http.get(
                f"{API}/user/info/",
                params={"fields": "open_id,avatar_url,display_name,username,follower_count"},
                headers=self._auth(tokens),
            )
        user = self._check(resp, "Perfil do TikTok").get("data", {}).get("user", {})
        return Account(
            id=user.get("open_id") or tokens.get("open_id") or "",
            name=user.get("display_name") or "Criador TikTok",
            handle=f"@{user['username']}" if user.get("username") else "@tiktok",
            avatar_url=user.get("avatar_url"),
            followers=user.get("follower_count"),
        )

    async def creator_info(self, tokens: dict[str, Any]) -> dict[str, Any]:
        """Opções que o TikTok permite a este criador agora (privacidade, duração máxima)."""
        async with self.client() as http:
            resp = await http.post(
                f"{API}/post/publish/creator_info/query/", headers=self._auth(tokens), json={}
            )
        return self._check(resp, "Permissões de publicação do TikTok").get("data", {})

    async def upload(
        self, tokens: dict[str, Any], account: dict[str, Any], video: VideoUpload
    ) -> UploadResult:
        chunk = video.size if video.size <= SINGLE_CHUNK_MAX else CHUNK
        chunks = max(1, video.size // chunk)
        source = {
            "source": "FILE_UPLOAD",
            "video_size": video.size,
            "chunk_size": chunk,
            "total_chunk_count": chunks,
        }
        if video.draft:
            # Vai para a caixa de rascunhos do app: nada é publicado.
            path, body = "/post/publish/inbox/video/init/", {"source_info": source}
        else:
            path = "/post/publish/video/init/"
            body = {
                "post_info": {
                    "title": f"{video.title}\n\n{video.description}".strip()[:2200],
                    "privacy_level": video.privacy,
                    "disable_duet": False,
                    "disable_stitch": False,
                    "disable_comment": False,
                    "video_cover_timestamp_ms": 1000,
                },
                "source_info": source,
            }
        async with self.client() as http:
            init = self._check(
                await http.post(f"{API}{path}", headers=self._auth(tokens), json=body),
                "Início do envio ao TikTok",
            ).get("data", {})
            upload_url, publish_id = init.get("upload_url"), init.get("publish_id")
            if not upload_url or not publish_id:
                raise ConnectorError(
                    "provider_error", "O TikTok não devolveu o endereço de envio.", retryable=True
                )
            with video.path.open("rb") as f:
                for index in range(chunks):
                    start = index * chunk
                    end = video.size - 1 if index == chunks - 1 else start + chunk - 1
                    data = f.read(end - start + 1)
                    resp = await http.put(
                        upload_url,
                        content=data,
                        headers={
                            "Content-Type": "video/mp4",
                            "Content-Length": str(len(data)),
                            "Content-Range": f"bytes {start}-{end}/{video.size}",
                        },
                    )
                    if resp.status_code not in (200, 201, 206):
                        self._check(resp, "Envio ao TikTok")
        return UploadResult(remote_id=publish_id, status="PROCESSING_UPLOAD", extra={"draft": video.draft})

    async def status(self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str) -> UploadResult:
        async with self.client() as http:
            resp = await http.post(
                f"{API}/post/publish/status/fetch/",
                headers=self._auth(tokens),
                json={"publish_id": remote_id},
            )
        data = self._check(resp, "Status no TikTok").get("data", {})
        post_ids = data.get("publicaly_available_post_id") or []
        return UploadResult(
            remote_id=remote_id,
            status=data.get("status", "unknown"),
            url=f"https://www.tiktok.com/video/{post_ids[0]}" if post_ids else None,
            extra={"fail_reason": data.get("fail_reason"), "uploaded_bytes": data.get("uploaded_bytes")},
        )

    async def followers(self, tokens: dict[str, Any], account: dict[str, Any]) -> int:
        async with self.client() as http:
            resp = await http.get(
                f"{API}/user/info/", params={"fields": "follower_count"}, headers=self._auth(tokens)
            )
        data = self._check(resp, "Seguidores no TikTok")
        return int((data.get("data") or {}).get("user", {}).get("follower_count", 0))

    async def revoke(self, tokens: dict[str, Any]) -> None:
        client_key, secret = self._creds()
        async with self.client() as http:
            await http.post(
                f"{API}/oauth/revoke/",
                data={"client_key": client_key, "client_secret": secret, "token": tokens["access_token"]},
            )


def webhook_signature_valid(header: str, body: bytes, secret: str, tolerance_seconds: int = 300) -> bool:
    """Cabeçalho TikTok-Signature: "t=<timestamp>,s=<HMAC-SHA256 de f'{t}.{corpo}'>"."""
    import hashlib
    import hmac
    import time

    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        timestamp = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - timestamp) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return secrets.compare_digest(expected, parts.get("s", ""))

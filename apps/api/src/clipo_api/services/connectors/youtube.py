"""YouTube (Data API v3): OAuth do Google, envio retomável, status e exclusão."""

import json
from datetime import UTC, datetime
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
    check_response,
)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 — endereço, não senha
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
API = "https://www.googleapis.com/youtube/v3"
ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
# O YouTube exige pedaços múltiplos de 256 KB no envio retomável.
CHUNK = 32 * 256 * 1024


class YouTube(Connector):
    platform = "youtube"
    label = "YouTube"
    # force-ssl permite enviar, editar e apagar os vídeos do canal; readonly lê o canal.
    scopes = (
        "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/youtube.readonly "
        "https://www.googleapis.com/auth/yt-analytics.readonly"
    )
    supports_delete = True

    def _creds(self) -> tuple[str | None, str | None]:
        s = get_settings()
        return s.youtube_client_id, s.youtube_client_secret

    def configured(self) -> bool:
        return all(self._creds())

    def authorize_url(self, state: str, redirect_uri: str, code_challenge: str | None) -> str:
        params = {
            "client_id": self._creds()[0],
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": self.scopes,
            "access_type": "offline",
            "prompt": "consent",  # garante o refresh_token também na reconexão
            "include_granted_scopes": "true",
            "state": state,
        }
        if code_challenge:
            params.update(code_challenge=code_challenge, code_challenge_method="S256")
        return f"{AUTH_URL}?{urlencode(params)}"

    async def _token(self, form: dict[str, Any]) -> TokenSet:
        client_id, secret = self._creds()
        async with self.client() as http:
            resp = await http.post(TOKEN_URL, data={**form, "client_id": client_id, "client_secret": secret})
        data = resp.json() if resp.content else {}
        if resp.status_code == 400 and data.get("error") == "invalid_grant":
            raise ReconnectRequired()
        data = check_response(resp, "Token do Google")
        return TokenSet(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token"),
            expires_at=TokenSet.expiry(data.get("expires_in")),
            scope=data.get("scope"),
        )

    async def exchange_code(self, code: str, redirect_uri: str, code_verifier: str | None) -> TokenSet:
        form = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri}
        if code_verifier:
            form["code_verifier"] = code_verifier
        tokens = await self._token(form)
        if not tokens.refresh_token:
            raise ConnectorError(
                "no_refresh_token", "O Google não devolveu acesso permanente. Conecte de novo."
            )
        return tokens

    async def refresh(self, tokens: dict[str, Any]) -> TokenSet:
        if not tokens.get("refresh_token"):
            raise ReconnectRequired()
        new = await self._token({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
        new.refresh_token = new.refresh_token or tokens["refresh_token"]  # o Google não manda de novo
        return new

    def _auth(self, tokens: dict[str, Any]) -> dict[str, str]:
        return {"Authorization": f"Bearer {tokens['access_token']}"}

    async def account(self, tokens: dict[str, Any]) -> Account:
        async with self.client() as http:
            resp = await http.get(
                f"{API}/channels",
                params={"part": "snippet,statistics", "mine": "true"},
                headers=self._auth(tokens),
            )
        items = check_response(resp, "Canal do YouTube").get("items") or []
        if not items:
            raise ConnectorError("no_channel", "Esta conta Google não tem canal no YouTube.")
        ch = items[0]
        snippet = ch.get("snippet", {})
        return Account(
            id=ch["id"],
            name=snippet.get("title") or "Canal do YouTube",
            handle=snippet.get("customUrl") or ch["id"],
            avatar_url=snippet.get("thumbnails", {}).get("default", {}).get("url"),
            followers=int(ch.get("statistics", {}).get("subscriberCount") or 0),
        )

    async def upload(
        self, tokens: dict[str, Any], account: dict[str, Any], video: VideoUpload
    ) -> UploadResult:
        meta = {
            "snippet": {
                "title": video.title[:100],
                "description": video.description[:5000],
                "tags": video.tags[:30],
                "categoryId": "22",
            },
            "status": {"privacyStatus": video.privacy, "selfDeclaredMadeForKids": False},
        }
        async with self.client() as http:
            start = await http.post(
                UPLOAD_URL,
                params={"uploadType": "resumable", "part": "snippet,status"},
                headers={
                    **self._auth(tokens),
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Length": str(video.size),
                    "X-Upload-Content-Type": "video/mp4",
                },
                content=json.dumps(meta),
            )
            check_response(start, "Início do envio ao YouTube")
            session = start.headers.get("location")
            if not session:
                raise ConnectorError(
                    "provider_error", "O YouTube não devolveu o endereço de envio.", retryable=True
                )
            result: dict[str, Any] = {}
            with video.path.open("rb") as f:
                offset = 0
                while offset < video.size:
                    chunk = f.read(CHUNK)
                    end = offset + len(chunk) - 1
                    resp = await http.put(
                        session,
                        content=chunk,
                        headers={
                            "Content-Length": str(len(chunk)),
                            "Content-Range": f"bytes {offset}-{end}/{video.size}",
                        },
                    )
                    if resp.status_code == 308:  # pedaço recebido, continue
                        offset = end + 1
                        continue
                    result = check_response(resp, "Envio ao YouTube")
                    break
        if not result.get("id"):
            raise ConnectorError("provider_error", "O YouTube não confirmou o envio.", retryable=True)
        return UploadResult(
            remote_id=result["id"],
            status=result.get("status", {}).get("uploadStatus", "uploaded"),
            url=f"https://youtu.be/{result['id']}",
        )

    async def status(self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str) -> UploadResult:
        async with self.client() as http:
            resp = await http.get(
                f"{API}/videos",
                params={"part": "status,processingDetails", "id": remote_id},
                headers=self._auth(tokens),
            )
        items = check_response(resp, "Status no YouTube").get("items") or []
        if not items:
            return UploadResult(remote_id=remote_id, status="not_found")
        item = items[0]
        return UploadResult(
            remote_id=remote_id,
            status=item.get("status", {}).get("uploadStatus", "unknown"),
            url=f"https://youtu.be/{remote_id}",
            extra={
                "privacy": item.get("status", {}).get("privacyStatus"),
                "processing": item.get("processingDetails", {}).get("processingStatus"),
                "rejection": item.get("status", {}).get("rejectionReason"),
            },
        )

    async def metrics(self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str) -> PostMetrics:
        async with self.client() as http:
            resp = await http.get(
                f"{API}/videos", params={"part": "statistics", "id": remote_id}, headers=self._auth(tokens)
            )
            items = check_response(resp, "Métricas no YouTube").get("items") or []
            if not items:
                raise ConnectorError("not_found", "O vídeo não está mais no YouTube.")
            stats = items[0].get("statistics", {})
            result = PostMetrics(
                views=int(stats.get("viewCount", 0)),
                likes=int(stats["likeCount"]) if "likeCount" in stats else None,
                comments=int(stats["commentCount"]) if "commentCount" in stats else None,
            )
            # Retenção e compartilhamentos vêm do YouTube Analytics (conexões feitas antes do
            # escopo de analytics não têm acesso; seguem só com as estatísticas públicas).
            report = await http.get(
                ANALYTICS,
                params={
                    "ids": "channel==MINE",
                    "startDate": "2005-01-01",
                    "endDate": datetime.now(UTC).strftime("%Y-%m-%d"),
                    "metrics": "shares,averageViewDuration,averageViewPercentage",
                    "filters": f"video=={remote_id}",
                },
                headers=self._auth(tokens),
            )
        if report.status_code == 200:
            rows = report.json().get("rows") or []
            if rows:
                result.shares, result.avg_view_s, result.retention_pct = (
                    int(rows[0][0]),
                    rows[0][1],
                    rows[0][2],
                )
        return result

    async def followers(self, tokens: dict[str, Any], account: dict[str, Any]) -> int:
        async with self.client() as http:
            resp = await http.get(
                f"{API}/channels", params={"part": "statistics", "mine": "true"}, headers=self._auth(tokens)
            )
        items = check_response(resp, "Inscritos no YouTube").get("items") or []
        return int(items[0]["statistics"].get("subscriberCount", 0)) if items else 0

    async def delete(self, tokens: dict[str, Any], account: dict[str, Any], remote_id: str) -> None:
        async with self.client() as http:
            resp = await http.delete(f"{API}/videos", params={"id": remote_id}, headers=self._auth(tokens))
        if resp.status_code not in (204, 404):
            check_response(resp, "Exclusão no YouTube")

    async def revoke(self, tokens: dict[str, Any]) -> None:
        token = tokens.get("refresh_token") or tokens.get("access_token")
        async with self.client() as http:
            await http.post(REVOKE_URL, data={"token": token})

"""Cliente HTTP para serviços externos. Toda chamada gera uma entrada no log do sistema.

Nenhuma integração (redes sociais, IA, pagamento, e-mail transacional) chama a internet por fora
daqui. Cada pedido grava método, URL sem segredos, status, tempo e, em caso de erro, o motivo.
"""

import time
from typing import Any

import httpx

from clipo_api.observability.logs import Category, record
from clipo_api.observability.redact import redact_url

# Respostas de erro dos provedores costumam trazer o motivo; guardamos só o começo.
_ERROR_BODY_LIMIT = 500


class LoggedClient(httpx.AsyncClient):
    def __init__(self, *, platform: str, category: Category = "integration", **kwargs: Any):
        kwargs.setdefault("timeout", httpx.Timeout(20.0))
        super().__init__(**kwargs)
        self._platform = platform
        self._category = category

    async def send(self, request: httpx.Request, **kwargs: Any) -> httpx.Response:
        started = time.perf_counter()
        details: dict[str, Any] = {"method": request.method, "url": redact_url(str(request.url))}
        try:
            response = await super().send(request, **kwargs)
        except httpx.HTTPError as exc:
            details["error"] = type(exc).__name__
            await record(
                self._category,
                "http.request",
                f"{request.method} {request.url.host} falhou: {type(exc).__name__}",
                level="error",
                outcome="failure",
                platform=self._platform,
                duration_ms=(time.perf_counter() - started) * 1000,
                details=details,
            )
            raise

        details["status"] = response.status_code
        failed = response.status_code >= 400
        if failed:
            # O corpo só é lido no erro (e já vem limitado); em sucesso pode ser um vídeo.
            await response.aread()
            details["response"] = response.text[:_ERROR_BODY_LIMIT]
        await record(
            self._category,
            "http.request",
            f"{request.method} {request.url.host}{request.url.path} → {response.status_code}",
            level="error" if response.status_code >= 500 else "warning" if failed else "info",
            outcome="failure" if failed else "success",
            platform=self._platform,
            duration_ms=(time.perf_counter() - started) * 1000,
            details=details,
        )
        return response

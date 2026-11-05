"""Middlewares de borda: id de requisição, log de acesso, cabeçalhos de segurança e CSRF."""

import json
import logging
import re
import secrets
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from clipo_api.core.config import get_settings
from clipo_api.observability.logs import request_id_var

ACCESS_COOKIE = "clipo_access"
REFRESH_COOKIE = "clipo_refresh"
CSRF_COOKIE = "clipo_csrf"
CSRF_HEADER = "x-csrf-token"

access_log = logging.getLogger("clipo.access")

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Rotas públicas: quem chama ainda não tem sessão, então não há o que um site terceiro roubar.
_CSRF_EXEMPT = {
    "/api/auth/register",
    "/api/auth/login",
    "/api/auth/verify-email",
    "/api/auth/resend-verification",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
}
# Retorno da Apple (POST vindo do site dela) e confirmação de troca de e-mail por link.
_CSRF_EXEMPT_PREFIXES = ("/api/v1/auth/oauth/", "/api/v1/account/email/confirm", "/api/v1/webhooks/")
_DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")
# Id de requisição vindo de fora só é aceito se for seguro para log e para cabeçalho.
_REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class JsonFormatter(logging.Formatter):
    """Uma linha JSON por evento. Nunca recebe corpo de requisição, senha ou token."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in ("request_id", "method", "path", "status", "ms"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger("clipo")
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    root.propagate = False


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if _REQUEST_ID.match(incoming) else uuid.uuid4().hex
        request.state.request_id = request_id
        # Todo log gravado durante esta requisição leva o mesmo id (ver observability.logs).
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = request_id
        access_log.info(
            "requisição",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "ms": round((time.perf_counter() - started) * 1000, 1),
            },
        )
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        headers = response.headers
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Referrer-Policy", "no-referrer")
        headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        if not request.url.path.startswith(_DOCS_PATHS):
            # A API só devolve JSON: nada pode ser carregado nem embutido a partir dela.
            headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        if get_settings().cookie_secure:
            headers.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
        return response


class CsrfMiddleware(BaseHTTPMiddleware):
    """Double submit: o valor do cookie clipo_csrf precisa vir também no cabeçalho X-CSRF-Token.

    Um site terceiro consegue fazer o navegador enviar os cookies, mas não consegue lê-los,
    então não tem como copiar o valor para o cabeçalho.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        exempt = request.url.path in _CSRF_EXEMPT or request.url.path.startswith(_CSRF_EXEMPT_PREFIXES)
        if request.method in _UNSAFE_METHODS and not exempt:
            has_session = ACCESS_COOKIE in request.cookies or REFRESH_COOKIE in request.cookies
            if has_session:
                cookie = request.cookies.get(CSRF_COOKIE, "")
                header = request.headers.get(CSRF_HEADER, "")
                if not cookie or not secrets.compare_digest(cookie, header):
                    return JSONResponse(
                        {
                            "error": {
                                "code": "csrf_failed",
                                "message": "Recarregue a página e tente de novo.",
                            }
                        },
                        status_code=403,
                    )
        return await call_next(request)

"""Formato único de erro: {"error": {"code", "message", "fields"?}}. Detalhe técnico só no log."""

import logging
import traceback

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("clipo.api")


class ApiError(HTTPException):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message},
            headers=headers,
        )


def _body(code: str, message: str, **extra: object) -> dict[str, object]:
    return {"error": {"code": code, "message": message, **extra}}


_DEFAULT_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    429: "rate_limited",
}


def install_error_handlers(app: FastAPI) -> None:
    # O Starlette levanta a própria classe para 404 e 405; ela é a base da do FastAPI.
    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        if isinstance(exc.detail, dict) and "code" in exc.detail:
            body = _body(exc.detail["code"], exc.detail["message"])
        else:
            body = _body(_DEFAULT_CODES.get(exc.status_code, "error"), str(exc.detail))
        return JSONResponse(body, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [
            {
                "field": ".".join(str(p) for p in err["loc"] if p != "body"),
                "message": err["msg"],
            }
            for err in exc.errors()
        ]
        return JSONResponse(
            _body("validation_error", "Confira os dados enviados.", fields=fields),
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        )

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("erro inesperado", extra={"path": request.url.path})
        from clipo_api.observability.logs import record

        frames = traceback.extract_tb(exc.__traceback__)[-5:]
        await record(
            "system",
            "unhandled_exception",
            f"Erro inesperado em {request.method} {request.url.path}: {type(exc).__name__}",
            level="error",
            outcome="failure",
            details={
                "exception": type(exc).__name__,
                # Só arquivo, linha e função: os valores das variáveis nunca entram no log.
                "where": [f"{f.filename.rsplit('/', 1)[-1]}:{f.lineno} {f.name}" for f in frames],
            },
        )
        return JSONResponse(
            _body(
                "internal_error",
                "Algo deu errado do nosso lado. Tente de novo em instantes.",
            ),
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

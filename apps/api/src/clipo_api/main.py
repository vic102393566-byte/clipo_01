import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from clipo_api.core.config import get_settings
from clipo_api.core.errors import install_error_handlers
from clipo_api.core.middleware import (
    CsrfMiddleware,
    RequestContextMiddleware,
    SecurityHeadersMiddleware,
    configure_logging,
)
from clipo_api.db.mongo import create_client, ensure_schema
from clipo_api.observability import logs
from clipo_api.routers import (
    account,
    admin,
    admin_logs,
    ai,
    analytics,
    assets,
    auth,
    billing,
    connections,
    health,
    ideas,
    internal,
    library,
    me,
    media,
    oauth,
    publications,
    templates,
    workspace,
)
from clipo_api.routers import settings as settings_router
from clipo_api.services.storage import StorageNotConfigured, ensure_bucket

log = logging.getLogger("clipo.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    client = create_client()
    app.state.mongo = client
    app.state.db = client[settings.mongodb_db]
    await ensure_schema(app.state.db)
    logs.configure(app.state.db)
    if not settings.is_production:
        try:
            await ensure_bucket()
        except (StorageNotConfigured, OSError) as exc:
            log.warning("armazenamento indisponível na subida: %s", type(exc).__name__)
    await logs.record("system", "api.started", "API iniciada", details={"environment": settings.environment})
    yield
    logs.configure(None)
    await client.close()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging()
    app = FastAPI(
        title="Clipo API",
        version="0.1.0",
        lifespan=lifespan,
        # Documentação interativa só fora de produção.
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )
    install_error_handlers(app)
    # A ordem importa: o último adicionado é o primeiro a rodar.
    app.add_middleware(CsrfMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-CSRF-Token", "X-Request-ID"],
    )
    app.add_middleware(RequestContextMiddleware)
    for module in (
        health,
        auth,
        oauth,
        me,
        account,
        library,
        connections,
        publications,
        media,
        ai,
        billing,
        admin_logs,
        admin,
        workspace,
        assets,
        templates,
        ideas,
        analytics,
        settings_router,
        internal,
    ):
        app.include_router(module.router)
    return app


app = create_app()

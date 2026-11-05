"""Entrada da API na Vercel (função Python). A Vercel procura um `app` ASGI neste arquivo."""

from clipo_api.main import app

__all__ = ["app"]

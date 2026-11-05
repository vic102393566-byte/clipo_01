"""Conectores das redes sociais, todos com a mesma interface (ver base.Connector)."""

from clipo_api.services.connectors.base import Connector
from clipo_api.services.connectors.instagram import Instagram
from clipo_api.services.connectors.tiktok import TikTok
from clipo_api.services.connectors.youtube import YouTube

CONNECTORS: dict[str, Connector] = {c.platform: c for c in (YouTube(), Instagram(), TikTok())}


def get(platform: str) -> Connector | None:
    return CONNECTORS.get(platform)

"""Arquivo por chave: os do próprio usuário, os do workspace ativo e fotos de perfil.

Vídeos, cortes e ativos usam as rotas /api/v1/.../media, que conferem o dono pelo documento.
"""

from fastapi import APIRouter, status
from fastapi.responses import RedirectResponse, Response

from clipo_api.core.auth import AuthUser
from clipo_api.core.errors import ApiError
from clipo_api.core.workspace import WsUser
from clipo_api.services import storage

router = APIRouter(tags=["arquivos"])


@router.get("/media/{key:path}", include_in_schema=False)
async def media_file(key: str, user: AuthUser, ws: WsUser) -> Response:
    # Foto de perfil aparece para quem divide workspace (lista da equipe); o resto só para o dono.
    avatar = key.startswith("users/") and "/avatar/" in key and ".." not in key
    if not (storage.owns_key(user.id, key) or storage.owns_key(ws.id, key) or avatar):
        raise ApiError(status.HTTP_404_NOT_FOUND, "not_found", "Arquivo não encontrado.")
    response = RedirectResponse(storage.presign_download(key), status_code=status.HTTP_302_FOUND)
    response.headers["Cache-Control"] = "private, max-age=60"
    return response

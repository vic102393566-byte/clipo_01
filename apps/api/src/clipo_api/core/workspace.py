"""Workspace: a conta do dono, compartilhada com quem ele convidou.

O id do workspace é o id do dono. Vídeos, cortes, agenda, roteiros etc. continuam gravados com
`user_id` = dono, então quota, plano e créditos de IA são sempre os do dono. Quem chama uma rota
de conteúdo recebe um `WorkspaceUser` cujo `id` é o do dono e `actor_id` é quem está agindo.

O workspace ativo vem do cookie `clipo_ws` (ou do cabeçalho `X-Workspace`). Sem nenhum dos dois,
ou se a pessoa não é mais membro, vale o próprio workspace.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request, status

from clipo_api.core.auth import AuthUser, CurrentUser
from clipo_api.core.errors import ApiError
from clipo_api.db.mongo import MongoDb

WS_COOKIE = "clipo_ws"
WS_HEADER = "x-workspace"

ROLES = ("owner", "editor", "writer", "reviewer")
ROLE_LABEL = {
    "owner": "Proprietário",
    "editor": "Editor Sênior",
    "writer": "Roteirista IA",
    "reviewer": "Revisor",
}

PERMISSIONS: dict[str, frozenset[str]] = {
    "owner": frozenset(
        {
            "content:read",
            "content:write",
            "publish",
            "scripts:write",
            "review",
            "team:manage",
            "settings:write",
        }
    ),
    "editor": frozenset({"content:read", "content:write", "publish", "scripts:write", "review"}),
    "writer": frozenset({"content:read", "scripts:write"}),
    "reviewer": frozenset({"content:read", "review"}),
}


@dataclass(frozen=True)
class WorkspaceUser(CurrentUser):
    # `id` (herdado) é o dono do workspace; `actor_id` é quem fez a requisição.
    actor_id: str = ""
    ws_role: str = "owner"

    @property
    def is_owner(self) -> bool:
        return self.ws_role == "owner"

    def can(self, permission: str) -> bool:
        return permission in PERMISSIONS[self.ws_role]


def _requested(request: Request) -> str | None:
    return request.headers.get(WS_HEADER) or request.cookies.get(WS_COOKIE)


async def workspace_user(request: Request, user: AuthUser, db: MongoDb) -> WorkspaceUser:
    wanted = _requested(request)
    if wanted and wanted != user.id:
        member = await db.workspace_members.find_one(
            {"workspace_id": wanted, "user_id": user.id, "status": "active"}, projection={"role": 1}
        )
        if member is not None:
            return WorkspaceUser(
                id=wanted,
                role=user.role,
                family_id=user.family_id,
                impersonator_id=user.impersonator_id,
                actor_id=user.id,
                ws_role=member["role"],
            )
    return WorkspaceUser(
        id=user.id,
        role=user.role,
        family_id=user.family_id,
        impersonator_id=user.impersonator_id,
        actor_id=user.id,
        ws_role="owner",
    )


def ws_can(permission: str) -> Callable[..., WorkspaceUser]:
    if not any(permission in p for p in PERMISSIONS.values()):
        raise ValueError(f"permissão desconhecida: {permission}")

    async def _check(ws: Annotated[WorkspaceUser, Depends(workspace_user)]) -> WorkspaceUser:
        if not ws.can(permission):
            raise ApiError(
                status.HTTP_403_FORBIDDEN,
                "workspace_forbidden",
                f"Seu papel neste workspace ({ROLE_LABEL[ws.ws_role]}) não permite isso.",
            )
        return ws

    return _check


# Qualquer membro (leitura).
WsUser = Annotated[WorkspaceUser, Depends(workspace_user)]
# Envia, edita e apaga vídeos, cortes, ativos e modelos.
WsEditor = Annotated[WorkspaceUser, Depends(ws_can("content:write"))]
# Agenda e publica nas redes.
WsPublisher = Annotated[WorkspaceUser, Depends(ws_can("publish"))]
# Ideias e roteiros.
WsWriter = Annotated[WorkspaceUser, Depends(ws_can("scripts:write"))]
# Aprova publicações e roteiros.
WsReviewer = Annotated[WorkspaceUser, Depends(ws_can("review"))]
# Equipe, automação e preferências do workspace.
WsOwner = Annotated[WorkspaceUser, Depends(ws_can("team:manage"))]

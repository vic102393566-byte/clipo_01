"""Papéis e permissões. Uma rota pede uma permissão, nunca um papel direto.

A matriz abaixo é a fonte única: os testes conferem cada permissão em cada papel.
"""

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, status

from clipo_api.core.auth import AuthUser, CurrentUser
from clipo_api.core.errors import ApiError
from clipo_api.observability.logs import record

ROLES = ("user", "support", "admin", "super_admin")

PERMISSIONS: dict[str, frozenset[str]] = {
    "user": frozenset(),
    "support": frozenset({"logs:read", "users:read", "jobs:read"}),
    "admin": frozenset(
        {
            "logs:read",
            "audit:read",
            "users:read",
            "users:manage",
            "users:impersonate",
            "plans:manage",
            "integrations:manage",
            "jobs:read",
            "jobs:manage",
            "metrics:read",
        }
    ),
    "super_admin": frozenset(
        {
            "logs:read",
            "audit:read",
            "users:read",
            "users:manage",
            "users:impersonate",
            "plans:manage",
            "integrations:manage",
            "jobs:read",
            "jobs:manage",
            "metrics:read",
            "roles:manage",
            "ai:manage",
            "settings:manage",
        }
    ),
}

ALL_PERMISSIONS = frozenset().union(*PERMISSIONS.values())


def has_permission(role: str, permission: str) -> bool:
    return permission in PERMISSIONS.get(role, frozenset())


def require_permission(permission: str) -> Callable[..., CurrentUser]:
    if permission not in ALL_PERMISSIONS:
        raise ValueError(f"permissão desconhecida: {permission}")

    async def _check(user: AuthUser) -> CurrentUser:
        if not has_permission(user.role, permission):
            await record(
                "admin",
                "permission.denied",
                f"Acesso negado: {permission}",
                level="warning",
                outcome="denied",
                details={"permission": permission, "role": user.role},
            )
            raise ApiError(status.HTTP_403_FORBIDDEN, "forbidden", "Você não tem permissão para isso.")
        return user

    return _check


def Requires(permission: str):  # noqa: N802 — usado como tipo: user: Requires("logs:read")
    return Annotated[CurrentUser, Depends(require_permission(permission))]

from fastapi import APIRouter, status

from clipo_api.core.auth import AuthUser
from clipo_api.core.errors import ApiError
from clipo_api.db.mongo import MongoDb
from clipo_api.routers.auth import public_user

router = APIRouter(prefix="/api", tags=["conta"])


@router.get("/me")
async def me(user: AuthUser, db: MongoDb) -> dict[str, object]:
    doc = await db.users.find_one({"_id": user.id})
    if doc is None:
        raise ApiError(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "Entre na sua conta para continuar.",
        )
    return {"user": public_user(doc)}

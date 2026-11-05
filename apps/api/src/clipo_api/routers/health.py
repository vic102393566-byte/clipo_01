from fastapi import APIRouter

from clipo_api.db.mongo import MongoDb

router = APIRouter(tags=["saúde"])


@router.get("/api/health")
async def health(db: MongoDb) -> dict[str, object]:
    """Responde 200 só se a API e o MongoDB estiverem acessíveis."""
    await db.command("ping")
    return {"ok": True, "database": "ok"}

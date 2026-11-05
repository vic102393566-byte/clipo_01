"""Acesso a dados de um usuário. O MongoDB não tem RLS: o isolamento entre contas mora aqui.

Toda coleção com dados de cliente é lida e escrita só por um `OwnedRepository`, criado com o
`user_id` da sessão. Ele injeta esse filtro em todas as operações e impede que o chamador o troque.
"""

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.asynchronous.collection import AsyncCollection

_OWNER = "user_id"


class OwnershipError(ValueError):
    """O chamador tentou consultar ou gravar o campo de dono por conta própria."""


def _check(fields: Mapping[str, Any]) -> None:
    if _OWNER in fields or "_id" in fields and isinstance(fields["_id"], dict):
        raise OwnershipError("o dono do documento vem da sessão, nunca da requisição")


class OwnedRepository:
    def __init__(self, collection: AsyncCollection, user_id: str):
        if not user_id:
            raise OwnershipError("user_id é obrigatório")
        self._col = collection
        self._user_id = user_id

    def _scope(self, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
        query = dict(query or {})
        _check(query)
        return {**query, _OWNER: self._user_id}

    async def insert(self, data: Mapping[str, Any]) -> dict[str, Any]:
        _check(data)
        doc = {
            "_id": uuid4().hex,
            **data,
            _OWNER: self._user_id,
            "created_at": datetime.now(UTC),
            "schema_version": 1,
        }
        await self._col.insert_one(doc)
        return doc

    async def get(self, doc_id: str) -> dict[str, Any] | None:
        return await self._col.find_one(self._scope({"_id": doc_id}))

    async def list(self, query: Mapping[str, Any] | None = None, *, limit: int = 50) -> list[dict[str, Any]]:
        cursor = self._col.find(self._scope(query)).sort("created_at", -1).limit(min(limit, 200))
        return await cursor.to_list()

    async def update(self, doc_id: str, changes: Mapping[str, Any]) -> dict[str, Any] | None:
        _check(changes)
        return await self._col.find_one_and_update(
            self._scope({"_id": doc_id}),
            {"$set": {**changes, "updated_at": datetime.now(UTC)}},
            return_document=ReturnDocument.AFTER,
        )

    async def delete(self, doc_id: str) -> bool:
        result = await self._col.delete_one(self._scope({"_id": doc_id}))
        return result.deleted_count == 1

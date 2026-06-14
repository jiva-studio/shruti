"""S3-backed `OutlineCache`.

Caches generated outline JSON under
`artifacts/tracks/<id>/outlines/<lang>.<model_tag>.c1.json`. The model tag
is injected by the existing helpers in `indexer.s3` so a model upgrade
implicitly invalidates the cache — the caller (and the port) only see
`(track_id, lang)`.

Conditional PUT (`If-None-Match: *`) is bridged through to
`OutlineCacheConflict`.
"""

from __future__ import annotations

import asyncio
from typing import Any

from lectorium_chat.config import Settings
from lectorium_chat.domain.ports.outline_cache import OutlineCacheConflict
from lectorium_chat.indexer.s3 import (
    OutlineAlreadyExists,
    get_outline_sync,
    outline_exists_sync,
    put_outline_sync,
)


class S3OutlineCache:
    def __init__(self, *, settings: Settings) -> None:
        self._settings = settings

    async def head(self, track_id: str, lang: str) -> bool:
        return await asyncio.to_thread(
            outline_exists_sync, track_id, lang, self._settings,
        )

    async def get(self, track_id: str, lang: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            get_outline_sync, track_id, lang, self._settings,
        )

    async def put(
        self,
        track_id: str,
        lang: str,
        payload: dict[str, Any],
        *,
        if_none_match: bool = False,
    ) -> None:
        try:
            await asyncio.to_thread(
                put_outline_sync, track_id, lang, payload, self._settings,
                if_none_match=if_none_match,
            )
        except OutlineAlreadyExists as exc:
            raise OutlineCacheConflict(str(exc)) from exc

"""What the PDF pipeline needs from storage."""

from __future__ import annotations

from typing import Any, Protocol


class ObjectStore(Protocol):
    async def exists(self, key: str) -> bool: ...

    async def get_text(self, key: str) -> str | None:
        """The object as text, or None when it does not exist."""
        ...

    async def get_json(self, key: str) -> dict[str, Any]: ...

    async def put(self, key: str, data: bytes, content_type: str) -> None: ...

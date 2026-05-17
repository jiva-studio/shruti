"""TranscriptStorage — port for fetching transcript JSONL by path.

Transcripts live in S3 under `public/tracks/<id>/transcripts/<lang>.json`.
The catalog stores the path (string); this port pulls the bytes and
parses them. The application never knows whether the backend is S3, a
local mount, or a fixture file.
"""

from __future__ import annotations

from typing import Any, Protocol


class TranscriptStorage(Protocol):
    async def fetch(self, path: str) -> dict[str, Any]:
        """Download the transcript at `path` and parse it as JSON.

        The returned shape is the same `{blocks: [...]}` structure the
        outline tool walks. Raises on network / parse error — callers
        decide how to recover."""
        ...

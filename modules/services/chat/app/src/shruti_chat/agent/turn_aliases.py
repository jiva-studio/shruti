"""Per-turn alias mapping for track ids.

The LLM never sees real catalog track ids. Tool results that would
normally carry `track_id` strings (`track_OkPVGYhR5PPu`, etc.) are
post-processed before reaching the model: each `(track_id, start_ms,
end_ms)` triple — or each `track_id` for whole-track entities — gets
a monotonically-incrementing integer alias, and the agent keeps the
real values in `TurnAliasMap` for the duration of the chat turn.

When the model later writes `[cite:N|caption]` / `[card:N]` /
`[outline:N]` in its prose, the stream filter expands `N` back into
the real `[cite:track_X@start-end|caption]` etc. before the marker
hits the client.

Why integers and not the canonical `track_X` format:
  * Hallucination prime is gone — there's no `track_…` / `BG_…` /
    `SB_…` token shape anywhere in the model's context to imitate.
  * Detection of invalid refs is a dict lookup (`int in self._chunks`),
    not a catalog query.
  * The cite vocabulary is small and visible to the model (`[1] … [5]`
    are in the same prompt window), so the prompt rule "cite only by
    number from the list" is a concrete constraint instead of the
    vague "do not fabricate ids".

Numbering is monotonic ACROSS tool calls in one turn — the first
search_transcripts gives 1-5, a subsequent list_tracks gives 6-10,
and so on. Re-aliasing the same `track_id` from a later tool call
returns a NEW number (we don't deduplicate); keeping it linear
matches how the model naturally reasons about the list it sees.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True, slots=True)
class ChunkRef:
    """The real-catalog metadata behind one integer alias.

    `start_ms` / `end_ms` are present only for SEARCH-level aliases
    (chunks). Whole-track aliases (from list_tracks / get_track) leave
    them None — the marker expander emits `[card:track_X]` instead of
    `[cite:track_X@...|caption]` for those.
    """

    track_id: str
    start_ms: int | None = None
    end_ms: int | None = None


class TurnAliasMap:
    """Mutable per-turn state. Lives for the duration of one
    `run_chat_turn` invocation; discarded at turn end."""

    def __init__(self) -> None:
        self._chunks: dict[int, ChunkRef] = {}
        self._next_id = 1

    def alias_chunk(
        self, track_id: str, start_ms: int, end_ms: int,
    ) -> int:
        """Mint an alias for a chunk-level reference (search result).
        Returns the integer the LLM should cite by."""
        n = self._next_id
        self._next_id += 1
        self._chunks[n] = ChunkRef(track_id=track_id, start_ms=int(start_ms), end_ms=int(end_ms))
        return n

    def alias_track(self, track_id: str) -> int:
        """Mint an alias for a whole-track reference (list_tracks /
        get_track / propose_card targets). No timestamps."""
        n = self._next_id
        self._next_id += 1
        self._chunks[n] = ChunkRef(track_id=track_id)
        return n

    def resolve(self, n: int) -> ChunkRef | None:
        return self._chunks.get(n)

    def dealias_many(self, refs: Iterable[int]) -> list[str]:
        """Translate a list of integer refs (as the LLM passes them
        into action tools) back to real catalog `track_id`s. Unknown
        refs are silently dropped — callers see only the realised ids
        and can decide what to do (e.g. propose_playlist will reject
        an empty validated list)."""
        out: list[str] = []
        for r in refs:
            try:
                k = int(r)
            except (TypeError, ValueError):
                continue
            ref = self._chunks.get(k)
            if ref is not None:
                out.append(ref.track_id)
        return out

    def __len__(self) -> int:
        return len(self._chunks)

    def __contains__(self, n: int) -> bool:
        return n in self._chunks

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
from typing import Any, Iterable


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

    def lookup_ref(
        self, track_id: str, start_ms: int | None, end_ms: int | None,
    ) -> int | None:
        """Reverse lookup: given a real catalog reference, find the
        integer alias we minted for it earlier in this turn. Used by
        `build_messages` to fold prior-assistant chip markers back
        into `[cite:N|...]` form when the client supplied this map as
        the message's `aliases` meta."""
        for n, ref in self._chunks.items():
            if ref.track_id != track_id:
                continue
            if ref.start_ms != start_ms or ref.end_ms != end_ms:
                continue
            return n
        return None

    def serialize(self) -> dict[str, dict[str, Any]]:
        """Wire-format dump: `{N (as str): {track_id, start_ms?, end_ms?}, ...}`.
        Keys are strings because JSON object keys must be strings — the
        client converts back to int on parse. Empty fields (None) are
        omitted so the payload stays small."""
        out: dict[str, dict[str, Any]] = {}
        for n, ref in self._chunks.items():
            entry: dict[str, Any] = {"track_id": ref.track_id}
            if ref.start_ms is not None:
                entry["start_ms"] = ref.start_ms
            if ref.end_ms is not None:
                entry["end_ms"] = ref.end_ms
            out[str(n)] = entry
        return out

    def load_external(self, serialized: dict[str, Any]) -> None:
        """Restore aliases sent back by the client with prior turns'
        history. Used to fold expanded chip markers in those prior
        assistant messages back into integer form before the LLM sees
        them. We accept the LARGEST seen `N` as the new `_next_id`
        floor so freshly-minted aliases this turn don't collide with
        history-side refs."""
        max_n = 0
        for k, entry in serialized.items():
            try:
                n = int(k)
            except (TypeError, ValueError):
                continue
            if not isinstance(entry, dict):
                continue
            tid = entry.get("track_id")
            if not isinstance(tid, str):
                continue
            start = entry.get("start_ms")
            end = entry.get("end_ms")
            self._chunks[n] = ChunkRef(
                track_id=tid,
                start_ms=int(start) if isinstance(start, int) else None,
                end_ms=int(end) if isinstance(end, int) else None,
            )
            if n > max_n:
                max_n = n
        if max_n >= self._next_id:
            self._next_id = max_n + 1

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

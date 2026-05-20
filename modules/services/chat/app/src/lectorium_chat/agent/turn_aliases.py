"""Per-turn alias mapping for track ids.

The LLM never sees real catalog track ids. Tool results that would
normally carry `track_id` strings (`track_OkPVGYhR5PPu`, etc.) are
post-processed before reaching the model: each `(track_id, start_ms,
end_ms)` triple — or each `track_id` for whole-track entities — gets
a NON-SEQUENTIAL integer alias drawn at random from `[1, 9999]`, and
the agent keeps the real values in `TurnAliasMap` for the duration of
the chat turn.

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

Numbers are drawn at random per allocation (uniqueness per turn enforced
via `_used`). This kills "predict-next-N" hallucinations — when the
model sees refs `{742, 18, 9001, 333}`, generating `[cite:9002]` is
obviously nonsense. Re-aliasing the same `track_id` from a later tool
call returns a NEW number (we don't deduplicate).
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Iterable

_REF_MIN = 1
_REF_MAX = 9999


@dataclass(frozen=True, slots=True)
class ChunkRef:
    """The real-catalog metadata behind one integer alias for a lecture track.

    `start_ms` / `end_ms` are present only for SEARCH-level aliases
    (chunks). Whole-track aliases (from list_tracks / get_track) leave
    them None — the marker expander emits `[card:track_X]` instead of
    `[cite:track_X@...|caption]` for those.
    """

    track_id: str
    start_ms: int | None = None
    end_ms: int | None = None


@dataclass(frozen=True, slots=True)
class VerseRef:
    """The real-library metadata behind one integer alias for a verse widget.

    Verses are addressed by (source_id, tokens) — same convention as
    `library.db` and `track_references`. The marker expander emits
    `[verse:source_id/tokens|caption]` for these.

    `addr_label` is the precomputed human address (e.g. "БГ 2.13") that
    came back with the chunks_search/chunks_get_by_address (verse) result. Carried through so the
    server can emit it in the `verse_payload` SSE event without
    re-querying the catalog short-name table.
    """

    source_id: str
    tokens: str
    addr_label: str | None = None


# Any kind of reference an integer alias may resolve to.
AliasRef = ChunkRef | VerseRef


class TurnAliasMap:
    """Mutable per-turn state. Lives for the duration of one
    `run_chat_turn` invocation; discarded at turn end."""

    def __init__(self) -> None:
        self._chunks: dict[int, AliasRef] = {}
        self._used: set[int] = set()

    def _alloc_ref(self) -> int:
        """Draw a fresh integer in [1, 9999] not already used in this
        turn. The address space (~10k) vs typical per-turn ref count
        (≤50) keeps the rejection loop O(1) in practice."""
        while True:
            n = random.randint(_REF_MIN, _REF_MAX)
            if n not in self._used:
                self._used.add(n)
                return n

    def alias_chunk(
        self, track_id: str, start_ms: int, end_ms: int,
    ) -> int:
        """Mint an alias for a chunk-level reference (search result).
        Returns the integer the LLM should cite by."""
        n = self._alloc_ref()
        self._chunks[n] = ChunkRef(track_id=track_id, start_ms=int(start_ms), end_ms=int(end_ms))
        return n

    def alias_track(self, track_id: str) -> int:
        """Mint an alias for a whole-track reference (list_tracks /
        get_track / propose_card targets). No timestamps."""
        n = self._alloc_ref()
        self._chunks[n] = ChunkRef(track_id=track_id)
        return n

    def alias_verse(
        self, source_id: str, tokens: str, addr_label: str | None = None,
    ) -> int:
        """Mint an alias for a library verse widget target. The LLM
        cites it via `[verse:N|caption]`; the marker expander unfolds
        N into `[verse:source_id/tokens|caption]` before the client
        sees it. `addr_label` is the precomputed human address from the
        chunks_search/chunks_get_by_address (verse) tool result; preserved so it can ride along in
        any verse_payload event without recomputation."""
        n = self._alloc_ref()
        self._chunks[n] = VerseRef(
            source_id=source_id, tokens=tokens, addr_label=addr_label,
        )
        return n

    def resolve(self, n: int) -> AliasRef | None:
        return self._chunks.get(n)

    def verse_refs(self) -> list[tuple[int, VerseRef]]:
        """All currently-minted verse aliases, in mint order. Used by
        the SSE transport to discover newly-cited verses after each
        tool call and emit a `verse_payload` per fresh one."""
        return [
            (n, ref) for n, ref in self._chunks.items()
            if isinstance(ref, VerseRef)
        ]

    def lookup_ref(
        self, track_id: str, start_ms: int | None, end_ms: int | None,
    ) -> int | None:
        """Reverse lookup for a track-shaped ref (lecture chunk or card)."""
        for n, ref in self._chunks.items():
            if not isinstance(ref, ChunkRef):
                continue
            if ref.track_id != track_id:
                continue
            if ref.start_ms != start_ms or ref.end_ms != end_ms:
                continue
            return n
        return None

    def lookup_verse_ref(self, source_id: str, tokens: str) -> int | None:
        """Reverse lookup for a verse-shaped ref."""
        for n, ref in self._chunks.items():
            if isinstance(ref, VerseRef) and ref.source_id == source_id and ref.tokens == tokens:
                return n
        return None

    def serialize(self) -> dict[str, dict[str, Any]]:
        """Wire-format dump. Track refs keep their legacy shape; verse refs
        ride a `kind="verse"` discriminator. Existing clients keep working;
        new clients learn the verse shape additively."""
        out: dict[str, dict[str, Any]] = {}
        for n, ref in self._chunks.items():
            if isinstance(ref, ChunkRef):
                entry: dict[str, Any] = {"track_id": ref.track_id}
                if ref.start_ms is not None:
                    entry["start_ms"] = ref.start_ms
                if ref.end_ms is not None:
                    entry["end_ms"] = ref.end_ms
            elif isinstance(ref, VerseRef):
                entry = {"kind": "verse", "source_id": ref.source_id, "tokens": ref.tokens}
            else:  # pragma: no cover — guarded by AliasRef union
                continue
            out[str(n)] = entry
        return out

    def load_external(self, serialized: dict[str, Any]) -> None:
        """Restore aliases sent back by the client with prior turns'
        history. Accepts both track-shape entries (with `track_id`) and
        verse-shape entries (with `kind="verse"`). Loaded refs are added
        to `_used` so freshly-minted aliases this turn don't collide
        with history-side refs."""
        for k, entry in serialized.items():
            try:
                n = int(k)
            except (TypeError, ValueError):
                continue
            if not isinstance(entry, dict):
                continue
            kind = entry.get("kind")
            if kind == "verse":
                sid = entry.get("source_id")
                tok = entry.get("tokens")
                if not isinstance(sid, str) or not isinstance(tok, str):
                    continue
                self._chunks[n] = VerseRef(source_id=sid, tokens=tok)
            else:
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
            self._used.add(n)

    def dealias_many(self, refs: Iterable[int]) -> list[str]:
        """Translate a list of integer refs (as the LLM passes them
        into action tools) back to real catalog `track_id`s. Unknown
        refs and verse refs (which carry no track_id) are silently
        dropped — callers see only the realised ids and can decide
        what to do (e.g. propose_playlist will reject an empty list)."""
        out: list[str] = []
        for r in refs:
            try:
                k = int(r)
            except (TypeError, ValueError):
                continue
            ref = self._chunks.get(k)
            if isinstance(ref, ChunkRef):
                out.append(ref.track_id)
        return out

    def __len__(self) -> int:
        return len(self._chunks)

    def __contains__(self, n: int) -> bool:
        return n in self._chunks

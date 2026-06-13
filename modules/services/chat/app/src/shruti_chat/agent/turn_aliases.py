"""Per-turn alias mapping for track ids.

The LLM never sees real catalog track ids. Tool results that would
normally carry `track_id` strings (`track_OkPVGYhR5PPu`, etc.) are
post-processed before reaching the model: each `(track_id, start_ms,
end_ms)` triple — or each `track_id` for whole-track entities — gets
a small SEQUENTIAL integer alias starting from 1, and the agent keeps
the real values in `TurnAliasMap` for the duration of the chat turn.

When the model later writes `[^N]` in its prose, the stream
filter expands `N` back into the real `[cite:track_X@start-end|caption]`
/ `[verse:source_id/tokens|...]` / `[card:track_X]` (chosen by alias
type) before the marker hits the client.

Why small sequential integers (not random or canonical track_X):
  * 1-2 digit numbers are trivial for small models (Flash-Lite) to
    copy verbatim across long output streams. Earlier random `[1, 9999]`
    drove the model to invent plausible-looking 4-digit refs mid-reply
    because the real integer fell out of working memory.
  * Hallucination prime is still gone — there's no `track_…` / `BG_…`
    token shape anywhere in the model's context to imitate.
  * Detection of invalid refs is a dict lookup (`int in self._chunks`),
    not a catalog query. An unresolvable `[^N]` is dropped by the
    expander — we never guess a substitute (see
    `MarkerExpander._format_ref`).

Re-aliasing the same `track_id` from a later tool call returns a NEW
number (we don't deduplicate at the mint site); the pipeline calls
`lookup_ref` / `lookup_verse_ref` to reuse an existing integer when
the same ref is seen twice in one turn.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True, slots=True)
class ChunkRef:
    """The real-catalog metadata behind one integer alias for a lecture track.

    `start_ms` / `end_ms` are present only for SEARCH-level aliases
    (chunks). Whole-track aliases (from list_tracks / get_track) leave
    them None — the marker expander emits `[card:track_X]` instead of
    `[cite:track_X@...|caption]` for those.

    `lang` is the transcript language of the cited fragment, captured at
    mint time from the chunk. `flush_cite_payloads` passes it when it has
    to re-fetch the snippet text on demand (fragments aliased outside the
    research pipeline never reach `chunk_texts`). Needed because the UI
    language and the lecture's transcript language differ — an English
    lecture cited in a ru-UI turn would miss with a `lang='ru'` filter.
    """

    track_id: str
    start_ms: int | None = None
    end_ms: int | None = None
    lang: str | None = None


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


@dataclass(frozen=True, slots=True)
class CommentaryRef:
    """The real-library metadata behind one integer alias for a quotable
    library document chunk — a commentary (purport / tika), a prose chapter,
    or a letter. All three share one citation mechanism (pre-split sentences
    + `[^N|s=…]` → verbatim blockquote); only `kind` records which is which.

    Sentences is the pre-split body of the chunk: when the LLM emits
    `[^N|s=0,2]` the marker expander pulls those sentences verbatim and
    builds a markdown blockquote attributed via `author_name + addr_label`
    (language-neutral — no per-kind service word). The split happens once at
    envelope-mint time so the expander stays a pure lookup.

    addr_label is the human address ("БГ 2.13" / a chapter or letter title);
    author_name is the resolved author full name from catalog (or None).
    kind is the source item_kind ("commentary" | "prose_chapter" | "letter").
    """

    item_id: str
    segment_index: int
    addr_label: str
    author_name: str | None
    sentences: tuple[str, ...]
    kind: str = "commentary"
    # Per-sentence MT translation into the turn's answer language, filled in
    # the worker (before the synthesizer streams) when `translate_citations`
    # is on and the commentary has no native variant. `_format_commentary`
    # renders `sentences_translated or sentences`, so an unset (None) field
    # leaves the original behaviour untouched. Index-aligned with `sentences`.
    sentences_translated: tuple[str, ...] | None = None
    # True when `sentences_translated` is machine-translated (vs native).
    mt: bool = False


@dataclass(frozen=True, slots=True)
class MediaRef:
    """The real-library REFERENCE behind one integer alias for a media clip
    — a short video/audio fragment (e.g. a devotee's remembrance about
    Srila Prabhupada) surfaced by semantic search as `kind='media'`.

    Reference-only, exactly like VerseRef: the alias carries just the
    `library_media` id (`item_id`) plus the display label/text. The LLM
    cites it via `[^N]` and the marker expander unfolds N into
    `[media:<id>|<caption>]`; `flush_media_payloads` resolves the playable
    handle (url / type / speaker) by reading `library_media` at turn time
    via fetch_media(item_id) and ships it in the `media` SSE payload BEFORE
    the marker reaches the client, so the media card renders the player.

    `label` is the server-built addr_label ("speaker · date" or the title);
    `text` is the DISPLAY string. No url / type / provenance is stored here
    — that is resolved from library_media at flush.
    """

    item_id: str
    label: str
    text: str = ""
    lang: str | None = None


@dataclass(frozen=True, slots=True)
class ChapterRef:
    """The real-library metadata behind one integer alias for a chapter-
    location widget — the answer to "where in scripture is this?".

    Unlike VerseRef (one shloka), a ChapterRef names a REGION of a book:
    a canto (or the book itself for single-level books like BG) plus the
    list of chapters within it that the located narrative spans. The
    marker expander emits `[chapter:source_id/region_token|region_label]`;
    the chapter titles ride to the client in the `chapter` SSE payload and
    are rendered verbatim by `ChapterCard.vue` — never echoed by the LLM.

    `region_token` is the canto token ("12") for 3-level books, or the
    book's single chapter token for 2-level books. `chapters` is the
    ordered (tokens, title) list shown inside the card.
    """

    source_id: str
    region_token: str
    region_label: str
    chapters: tuple[tuple[str, str], ...]  # (tokens, title), numerically ordered


# Any kind of reference an integer alias may resolve to.
AliasRef = ChunkRef | VerseRef | CommentaryRef | ChapterRef | MediaRef


class TurnAliasMap:
    """Mutable per-turn state. Lives for the duration of one
    `run_chat_turn` invocation; discarded at turn end."""

    def __init__(self) -> None:
        self._chunks: dict[int, AliasRef] = {}
        self._next: int = 1
        # Per-turn cache of LLM-generated audio-fragment captions,
        # keyed by alias int. Populated by a background task in
        # `research.pipeline` that runs Flash-Lite once per turn over
        # the final set of cite-able lecture fragments. The marker
        # expander reads `captions.get(n, "")` when expanding a
        # ChunkRef with timestamps — graceful degradation: if the
        # background task hasn't filled the slot by the time the LLM
        # emits `[^N]`, the audio chip renders without a caption
        # (widget still shows title + timestamp).
        self.captions: dict[int, str] = {}
        # Per-turn transcript text for cite-able lecture fragments,
        # keyed by alias int. Populated in `research.pipeline` over the
        # final cite-able set (same loop that seeds `captions`). The SSE
        # transport reads it in `flush_cite_payloads` to push the snippet
        # text to the client as an `action.kind=cite_transcript` event so
        # `CitationCard.vue` can render the full quote block. Empty until
        # the research path fills it — clients fall back to the chip.
        self.chunk_texts: dict[int, str] = {}

    def _alloc_ref(self) -> int:
        """Allocate the next sequential alias integer for this turn."""
        n = self._next
        self._next += 1
        return n

    def known_keys(self) -> set[int]:
        """All alias integers minted so far. Used by `MarkerExpander`
        for the `chat_marker_alias_miss` diagnostic (which minted
        aliases went uncited when an unresolvable `[^N]` is dropped)."""
        return set(self._chunks.keys())

    def alias_chunk(
        self, track_id: str, start_ms: int, end_ms: int, lang: str | None = None,
    ) -> int:
        """Mint an alias for a chunk-level reference (search result).
        Returns the integer the LLM should cite by. `lang` is the
        fragment's transcript language — carried so `flush_cite_payloads`
        can re-fetch the snippet text with the right language filter when
        it wasn't stashed in `chunk_texts`."""
        n = self._alloc_ref()
        self._chunks[n] = ChunkRef(
            track_id=track_id, start_ms=int(start_ms), end_ms=int(end_ms), lang=lang,
        )
        return n

    def alias_track(self, track_id: str) -> int:
        """Mint an alias for a whole-track reference (list_tracks /
        get_track / propose_card targets). No timestamps."""
        n = self._alloc_ref()
        self._chunks[n] = ChunkRef(track_id=track_id)
        return n

    def alias_commentary(
        self,
        item_id: str,
        segment_index: int,
        *,
        addr_label: str,
        author_name: str | None,
        sentences: list[str],
        kind: str = "commentary",
    ) -> int:
        """Mint an alias for a quotable library document chunk — a commentary
        (purport / tika), a prose chapter, or a letter (`kind`). The LLM cites
        it via `[^N|s=...]`; the marker expander unfolds N into a markdown
        blockquote with the picked sentences pulled verbatim from `sentences`
        and attributed via `author_name + addr_label` (language-neutral)."""
        n = self._alloc_ref()
        self._chunks[n] = CommentaryRef(
            item_id=item_id,
            segment_index=int(segment_index or 0),
            addr_label=addr_label,
            author_name=author_name,
            sentences=tuple(sentences),
            kind=kind,
        )
        return n

    def alias_verse(
        self, source_id: str, tokens: str, addr_label: str | None = None,
    ) -> int:
        """Mint an alias for a library verse widget target. The LLM
        cites it via `[^N]`; the marker expander unfolds
        N into `[verse:source_id/tokens|caption]` before the client
        sees it. `addr_label` is the precomputed human address from the
        chunks_search/chunks_get_by_address (verse) tool result; preserved so it can ride along in
        any verse_payload event without recomputation."""
        n = self._alloc_ref()
        self._chunks[n] = VerseRef(
            source_id=source_id, tokens=tokens, addr_label=addr_label,
        )
        return n

    def alias_chapter(
        self,
        source_id: str,
        region_token: str,
        region_label: str,
        chapters: list[tuple[str, str]],
    ) -> int:
        """Mint an alias for a chapter-location widget. The LLM cites it
        via `[^N]`; the marker expander unfolds N into
        `[chapter:source_id/region_token|region_label]`, and
        `flush_chapter_payloads` ships the `chapters` list (titles
        verbatim) in the `chapter` SSE payload."""
        n = self._alloc_ref()
        self._chunks[n] = ChapterRef(
            source_id=source_id,
            region_token=region_token,
            region_label=region_label,
            chapters=tuple(chapters),
        )
        return n

    def alias_media(
        self,
        item_id: str,
        *,
        label: str,
        text: str = "",
        lang: str | None = None,
    ) -> int:
        """Mint a reference-only alias for a media clip widget target. The
        LLM cites it via `[^N]`; the marker expander unfolds N into
        `[media:<id>|<caption>]`, and `flush_media_payloads` resolves the
        playable handle via fetch_media(item_id) and ships it in the `media`
        SSE payload before the marker reaches the client."""
        n = self._alloc_ref()
        self._chunks[n] = MediaRef(
            item_id=item_id,
            label=label,
            text=text,
            lang=lang,
        )
        return n

    def commentary_refs(self) -> list[tuple[int, CommentaryRef]]:
        """All currently-minted commentary aliases, in mint order. Used by
        the worker to pre-translate purport sentences before the synthesizer
        streams `[^N|s=…]` markers (inline blockquotes can't fetch a
        translation mid-stream)."""
        return [
            (n, ref) for n, ref in self._chunks.items()
            if isinstance(ref, CommentaryRef)
        ]

    def set_commentary_translation(
        self, n: int, *, sentences_translated: tuple[str, ...], mt: bool,
    ) -> None:
        """Attach a per-sentence translation to a minted commentary alias.

        CommentaryRef is frozen, so we rebuild it in place. No-op if `n`
        isn't a commentary ref."""
        ref = self._chunks.get(n)
        if not isinstance(ref, CommentaryRef):
            return
        from dataclasses import replace

        self._chunks[n] = replace(
            ref, sentences_translated=sentences_translated, mt=mt,
        )

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

    def has_verse_or_chapter(self, source_id: str, tokens: str) -> bool:
        """True if a verse/chapter with this (source_id, tokens) was aliased
        this turn — i.e. actually surfaced by retrieval. Lets the marker
        expander reject a bypass `[verse:…]`/`[chapter:…]` the model TYPED for
        content it was never given (a hallucinated card — observed: prose said
        BG 16.4-18 but the marker pointed at BG 17.16)."""
        for ref in self._chunks.values():
            if isinstance(ref, VerseRef) and ref.source_id == source_id and ref.tokens == tokens:
                return True
            if isinstance(ref, ChapterRef) and ref.source_id == source_id and ref.region_token == tokens:
                return True
        return False

    def chapter_refs(self) -> list[tuple[int, ChapterRef]]:
        """All currently-minted chapter-location aliases, in mint order.
        Used by `flush_chapter_payloads` to emit a `chapter` payload per
        fresh region before the `[chapter:...]` marker reaches the client."""
        return [
            (n, ref) for n, ref in self._chunks.items()
            if isinstance(ref, ChapterRef)
        ]

    def media_refs(self) -> list[tuple[int, MediaRef]]:
        """All currently-minted media aliases, in mint order. Used by
        `flush_media_payloads` to emit a `media` payload per fresh clip
        before the `[media:<id>|...]` marker reaches the client."""
        return [
            (n, ref) for n, ref in self._chunks.items()
            if isinstance(ref, MediaRef)
        ]

    def cite_refs(self) -> list[tuple[int, ChunkRef]]:
        """All currently-minted lecture-FRAGMENT aliases (ChunkRef with
        timestamps), in mint order. Used by the SSE transport to emit a
        `cite_transcript` payload per fragment so the client can render
        the full quote card. Whole-track ChunkRefs (no timestamps) are
        excluded — they render as track tiles, not quotes."""
        return [
            (n, ref) for n, ref in self._chunks.items()
            if isinstance(ref, ChunkRef)
            and ref.start_ms is not None
            and ref.end_ms is not None
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
                if ref.lang is not None:
                    entry["lang"] = ref.lang
            elif isinstance(ref, VerseRef):
                entry = {"kind": "verse", "source_id": ref.source_id, "tokens": ref.tokens}
            elif isinstance(ref, ChapterRef):
                entry = {
                    "kind": "chapter",
                    "source_id": ref.source_id,
                    "region_token": ref.region_token,
                    "region_label": ref.region_label,
                    "chapters": [
                        {"tokens": tok, "title": title}
                        for tok, title in ref.chapters
                    ],
                }
            elif isinstance(ref, MediaRef):
                # Media alias is reference-only: round-trip just the
                # library_media id + label so a multi-turn client echoing
                # this map back keeps the integer valid. The playback handle
                # is resolved on demand via fetch_media(item_id). `text` is
                # display-only and omitted to keep the persisted map small.
                entry = {
                    "kind": "media",
                    "item_id": ref.item_id,
                    "label": ref.label,
                }
            elif isinstance(ref, CommentaryRef):
                # Commentary alias is server-side only: the LLM picks
                # sentences via `[^N|s=...]` and the expander inlines them
                # as markdown blockquote, so the client never needs the
                # raw `sentences` list. Persist enough so a multi-turn
                # client echoing this map back keeps the integer valid
                # (item_id + segment_index suffice for cache lookup).
                entry = {
                    "kind": "commentary",
                    "item_id": ref.item_id,
                    "segment_index": ref.segment_index,
                }
            else:  # pragma: no cover — guarded by AliasRef union
                continue
            out[str(n)] = entry
        return out

    def load_external(self, serialized: dict[str, Any]) -> None:
        """Restore aliases sent back by the client with prior turns'
        history. Accepts both track-shape entries (with `track_id`) and
        verse-shape entries (with `kind="verse"`). The sequential mint
        counter is advanced past every loaded integer so freshly-minted
        aliases this turn don't collide with history-side refs."""
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
            elif kind == "media":
                item_id = entry.get("item_id")
                if not isinstance(item_id, str):
                    continue
                self._chunks[n] = MediaRef(
                    item_id=item_id,
                    label=entry.get("label", "") or "",
                )
            elif kind == "chapter":
                sid = entry.get("source_id")
                region_token = entry.get("region_token")
                if not isinstance(sid, str) or not isinstance(region_token, str):
                    continue
                chapters = tuple(
                    (c.get("tokens", ""), c.get("title", ""))
                    for c in entry.get("chapters", [])
                    if isinstance(c, dict)
                )
                self._chunks[n] = ChapterRef(
                    source_id=sid,
                    region_token=region_token,
                    region_label=entry.get("region_label", "") or "",
                    chapters=chapters,
                )
            else:
                tid = entry.get("track_id")
                if not isinstance(tid, str):
                    continue
                start = entry.get("start_ms")
                end = entry.get("end_ms")
                lang = entry.get("lang")
                self._chunks[n] = ChunkRef(
                    track_id=tid,
                    start_ms=int(start) if isinstance(start, int) else None,
                    end_ms=int(end) if isinstance(end, int) else None,
                    lang=lang if isinstance(lang, str) else None,
                )
            if n >= self._next:
                self._next = n + 1

    def dealias_many(self, refs: Iterable[int]) -> list[str]:
        """Translate a list of integer refs (as the LLM passes them
        into action tools) back to real catalog `track_id`s. Unknown
        refs and verse refs (which carry no track_id) are silently
        dropped — callers see only the realised ids and can decide
        what to do (e.g. track_pdf_generate will reject an empty list)."""
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

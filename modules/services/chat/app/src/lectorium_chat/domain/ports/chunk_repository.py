"""ChunkRepository — port for transcript-chunk reads.

Operations the application uses today:

- `search_by_embedding` — ANN over `chunks` with optional language,
  optional allowlist of track ids, and optional excluded track ids.
  Returns chunks scored by cosine similarity.
- `get_window` — chunks around a timecode for citation context.
- `get_anchor_texts` — raw chunk text for an anchor span; used by
  `chunks_find_similar` to build a query embedding.

The port is intentionally narrow. New use-cases extend it explicitly;
we do not expose a generic "execute SQL" method.
"""

from __future__ import annotations

from typing import Protocol

from lectorium_chat.domain.entities import (
    AttributionCandidate,
    Chunk,
    LibraryChunk,
    ScoredChunk,
    ScoredLibraryChunk,
)


class ChunkRepository(Protocol):
    async def distinct_langs(self) -> list[str]:
        """Distinct `lang` values present in the `chunks` table — i.e. the
        languages the corpus actually has content in. Drives the
        answer-lang-vs-retrieval-lang split: a request `lang` outside this
        set has no corpus, so retrieval clamps to English while the answer
        prose is still written in the requested language. Data-driven —
        the corpus language set is never hardcoded. Cached (24h)."""
        ...

    async def get_owned_track_ids(self, user_id: str) -> list[str]:
        """Track ids the given user (JWT `sub`) may retrieve in the private
        `user_track` lane, read from the server-side `owned` ACL projection.
        Never derived from client-supplied history. Empty for anon/unknown
        users; best-effort (a missing projection yields [])."""
        ...

    async def get_owned_track_ids_by_author(
        self, user_id: str, author_ids: list[str], author_raws: list[str] | None = None,
    ) -> list[str]:
        """This user's own tracks by one of `author_ids` (catalog authors) or with
        one of `author_raws` (names their uploads recorded, matched exactly). A
        track with neither is not returned."""
        ...

    async def get_own_author_names(self, user_id: str) -> list[str]:
        """Distinct speaker names across this person's own uploads — the pool an
        asked-for name is matched against when the catalog does not know it."""
        ...

    async def owned_langs_for_authors(
        self, user_id: str, author_ids: list[str], author_raws: list[str],
    ) -> list[str]:
        """Languages of this person's own recordings by the given lecturers — so
        an answer can say "they are in English" instead of "nothing found"."""
        ...

    async def unattributed_owned_count(self, user_id: str) -> int:
        """How many of this user's own tracks have no resolved speaker — they
        fall out of every lecturer-filtered answer, and saying so is the only
        way the person can tell why."""
        ...

    async def search_by_embedding(
        self,
        embedding: list[float],
        *,
        eligible_track_ids: list[str] | None = None,
        excluded_track_ids: list[str] | None = None,
        lang: str | None,
        top_k: int,
        kind: str = "track_transcript",
    ) -> list[ScoredChunk]:
        """ANN search over lecture chunks of a single `kind`. Implementations
        apply the active `embed_model` filter and restrict to the requested
        `kind`. `kind='track_transcript'` (default) is the public corpus;
        `kind='user_track'` is the private per-user lane — the two are
        physically separate partial HNSW indexes, so the default search can
        never return private rows. Library content (verse/commentary/…) lives
        in the same table but is queried via `search_library_by_embedding`."""
        ...

    async def search_library_by_embedding(
        self,
        embedding: list[float],
        *,
        kinds: list[str],
        source_id: str | None = None,
        author_id: str | None = None,
        lang: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        top_k: int = 8,
    ) -> list[ScoredLibraryChunk]:
        """ANN search over library chunks. `kinds` is required and at
        least one of {'verse','commentary','prose_chapter','letter'}.
        `date_from`/`date_to` apply only to letters (ISO-string compare
        on `doc_date`).
        """
        ...

    async def search_chunks_lexical(
        self,
        query_text: str,
        query_embedding: list[float],
        *,
        kinds: list[str],
        lang: str | None = None,
        source_id: str | None = None,
        author_id: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        top_k: int = 24,
        trgm_min_sim: float = 0.3,
    ) -> list[ScoredLibraryChunk]:
        """Lexical recall lane for hybrid retrieval over library chunks:
        full-text (`russian` morphology + `simple` for Sanskrit translit) +
        pg_trgm on the canonical address. Catches what dense ANN misses
        (addresses, transliteration, short verses). Ordered by lexical
        relevance (position = lexical rank for RRF); `score` carries the TRUE
        cosine vs `query_embedding` so downstream coverage/max_score gates stay
        honest. Rows lacking an embedding for the active model are dropped.
        """
        ...

    async def get_window(
        self,
        track_id: str,
        around_ms: int,
        *,
        window_ms: int,
        lang: str | None,
        max_chunks: int,
    ) -> list[Chunk]:
        """Chunks whose [start_ms, end_ms] overlaps
        [around_ms - window_ms, around_ms + window_ms]."""
        ...

    async def get_anchor_texts(
        self,
        track_id: str,
        *,
        start_ms: int | None,
        end_ms: int | None,
        lang: str | None,
        limit: int,
    ) -> list[str]:
        """Raw chunk texts for an anchor span. When `start_ms/end_ms` is
        omitted, returns the first `limit` chunks of the track."""
        ...

    async def get_chunk_text_exact(
        self,
        track_id: str,
        *,
        start_ms: int,
        end_ms: int,
        lang: str | None,
    ) -> str | None:
        """Transcript text of the ONE lecture chunk whose bounds exactly
        equal (start_ms, end_ms). Unlike `get_anchor_texts` (overlap match)
        this never bleeds in neighbouring/overlapping chunks, so the text
        corresponds 1:1 to the cited [start_ms, end_ms] window. Restricted
        to `kind='track_transcript'`. Returns None when no row matches
        (e.g. a focus span the user tapped that isn't a chunk boundary)."""
        ...

    async def get_chunks_by_addr_label(
        self,
        addr_label: str,
        *,
        kinds: list[str],
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        """Direct exact-match lookup for library chunks by their
        precomputed addr_label (e.g. "БГ 2.13", "BG 2.13", "SB 5.5.3").
        Used by `chunks_get_by_address` (verse/commentary) when the user
        names a specific verse — semantic ANN over a short address
        string is unreliable, but the address is unique inside its
        `kind` family so equality wins.

        `kinds` is required and filters to one or more of
        {'verse','commentary','prose_chapter','letter'} — a single
        addr_label can resolve to a verse AND its commentary, callers
        narrow to the kind they want.

        When `lang` is None, returns all language variants of the
        matching chunks. Returns an empty list if no row matches.
        """
        ...

    async def get_chunks_by_verse(
        self,
        *,
        source_id: str,
        tokens: str,
        kinds: list[str],
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        """Lookup library chunks by verse address `(source_id, tokens)` —
        language-independent join key. One address can resolve to a verse
        AND any number of commentaries / prose chapters anchored on it;
        callers narrow via `kinds`. Used by the research pipeline to
        expand verse hits with their commentaries from all authors.
        """
        ...

    async def find_attributions(
        self,
        embedding: list[float],
        *,
        kind: str,
        lang: str | None,
    ) -> list[AttributionCandidate]:
        """Top curated attributions of one `kind` ('pinned' / 'boost' /
        'memory') by cosine against `embedding`, best variant per
        attribution, score-descending. `lang=None` searches every language
        (the cross-lingual stage). Implementations apply the active
        `embed_model` filter and resolve the per-dim embedding table
        themselves — the caller never names either."""
        ...

    async def attribution_texts(
        self, attribution_id: str, *, lang: str | None,
    ) -> list[str]:
        """The curated phrasings of one attribution, for the border-zone
        judge to score the user query against. Prefers `lang`; falls back
        to every language when it has none there, so a cross-lingual
        border match still has text to rerank."""
        ...

    async def fetch_attribution_note(
        self, attribution_id: str, *, lang: str,
    ) -> str | None:
        """The full note of a matched `memory` attribution. Prefers `lang`,
        then English, then any (the synthesizer reads any language and
        still answers in the user's). None when the attribution has none."""
        ...

    async def get_chunks_by_target(
        self,
        *,
        ref_kind: str,         # "verse" | "document"
        target_id: str,        # opaque verse.id or library_document.id
        lang: str | None = None,
    ) -> list[LibraryChunk]:
        """Resolve a CanonicalRef → list of chunks. `ref_kind="verse"`
        narrows to chunks.kind='verse'; `ref_kind="document"` expands to
        chunks.kind IN ('commentary','prose_chapter','letter') because the
        library indexer flattens DocumentKind into the chunks discriminator.

        Used by research/pipeline.fetch_refs to materialise authoritative
        refs from a question-attribution match.
        """
        ...

"""ChunkRepository — port for transcript-chunk reads.

Operations the application uses today:

- `search_by_embedding` — ANN over `chunks` with optional language,
  optional allowlist of track ids, and optional excluded track ids.
  Returns chunks scored by cosine similarity.
- `get_window` — chunks around a timecode for citation context.
- `get_anchor_texts` — raw chunk text for an anchor span; used by
  `chunks_find_similar` to build a query embedding.
- `get_first_chunk_embeddings` — one representative embedding per
  track (the first chunk's vector); used by `user_recommendations_get`
  to compute the user's listening centroid.

The port is intentionally narrow. New use-cases extend it explicitly;
we do not expose a generic "execute SQL" method.
"""

from __future__ import annotations

from typing import Protocol

from lectorium_chat.domain.entities import Chunk, LibraryChunk, ScoredChunk, ScoredLibraryChunk


class ChunkRepository(Protocol):
    async def distinct_langs(self) -> list[str]:
        """Distinct `lang` values present in the `chunks` table — i.e. the
        languages the corpus actually has content in. Drives the
        answer-lang-vs-retrieval-lang split: a request `lang` outside this
        set has no corpus, so retrieval clamps to English while the answer
        prose is still written in the requested language. Data-driven —
        the corpus language set is never hardcoded. Cached (24h)."""
        ...

    async def search_by_embedding(
        self,
        embedding: list[float],
        *,
        eligible_track_ids: list[str] | None = None,
        excluded_track_ids: list[str] | None = None,
        lang: str | None,
        top_k: int,
    ) -> list[ScoredChunk]:
        """ANN search over lecture-transcript chunks. Implementations
        apply the active `embed_model` filter AND restrict to
        `kind='track_transcript'` internally — library content lives in
        the same table but is queried via `search_library_by_embedding`."""
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

    async def get_first_chunk_embeddings(
        self,
        track_ids: list[str],
        *,
        lang: str | None,
    ) -> list[list[float]]:
        """One embedding per track (the first chunk by `start_ms`).
        Tracks without a matching chunk are silently dropped."""
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

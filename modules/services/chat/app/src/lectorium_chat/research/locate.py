"""run_locate — orchestrator for the `locate` intent ("where in scripture
is this topic/story?").

Code-driven (no LLM tool-selection), mirroring `research.pipeline.run_research`
but far leaner. Three signals, precision-first:

  (a) Curated attributions — the only reliable signal for narrative *scope*
      (e.g. Prahlāda = SB 7.1–7.10 incl. the Hiraṇyakaśipu setup chapters).
      A `title` ref resolves to a chapter via `fetch_titles`; a `verse` ref
      resolves via `chunk_repo.get_chunks_by_target`.
  (b) Chapter-title semantic match — the `title` chunk kind (many chapters
      are named after the very story).
  (c) Verse-translation semantic match — the long-tail fallback.

The result is grouped book-aware (SB canto.chapter.verse vs BG chapter.verse),
tokens sorted numerically, and rendered either as chapter regions or as
individual verses depending on the question's granularity. Titles come from
`library_titles` verbatim — never fabricated. Nothing found → empty result.
"""

from __future__ import annotations

import asyncio
import re
from itertools import chain
from typing import Any, Callable

from lectorium_chat.domain.source_ids import chunk_source_filter
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.attribution_lookup import find_attributions
from lectorium_chat.research.constants import (
    TIMEOUT_FANOUT_S,
    TIMEOUT_QUESTION_LOOKUP_S,
)
from lectorium_chat.research.models import (
    AttributionMatch,
    AttributionRef,
    LocateChapter,
    LocateRegion,
    LocateResult,
    LocateVerse,
)


log = get_logger(__name__)

OnEvent = Callable[[str, dict[str, Any]], None]

# Relevance floor for semantic hits — same cut chunks_search uses.
_SCORE_FLOOR = 0.45
# Max chapter-regions surfaced before we flag the cut as "основные места".
_MAX_REGIONS = 4
# Max individual verses surfaced in verse-granularity mode.
_MAX_VERSES = 4
# boost-attribution accept thresholds for LOCATE specifically. Locate matches
# the user's FULL QUERY against curated boost (topical) LABELS, so cosines run
# lower than the boost-vs-extracted-topic case the global 0.70/0.65
# (BOOST_ACCEPT_*) were tuned for. Measured: the correct «История Махараджи Прахлады» topic
# scored 0.633 for "в какой песни ШБ история Прахлады" (just under 0.65) while
# the next, unrelated candidate sat at 0.544 — so ~0.60 catches the real story
# and still rejects the noise.
_LOCATE_BOOST_ACCEPT_NATIVE = 0.60
_LOCATE_BOOST_ACCEPT_CROSS = 0.58

# Lexical cues that force a granularity. Russian + English stems.
_VERSE_CUE = re.compile(r"стих|шлок|śloka|shloka|\bverse\b|\bтекст\b", re.IGNORECASE)
_CHAPTER_CUE = re.compile(
    r"глав|песн|канто|\bcanto\b|\bchapter\b|\bгде\b|\bwhere\b|\bв\s+как", re.IGNORECASE
)


def _numeric_key(tokens: str) -> tuple[int | str, ...]:
    """Sort key that orders "7.2" before "7.10" (string sort gets it wrong).

    Compound tokens ("1.2.28,1.2.29") sort by their first address. Each
    dot-segment becomes an int when numeric, else the raw string (so a
    stray non-numeric token still sorts deterministically)."""
    primary = tokens.split(",")[0]
    out: list[int | str] = []
    for seg in primary.split("."):
        out.append(int(seg) if seg.isdigit() else seg)
    return tuple(out)


def _short_name(addr_label: str, tokens: str) -> str:
    """Derive the book short-name from an addr_label by stripping the
    trailing token address — "ШБ 7.5.23" → "ШБ". Falls back to the whole
    label when the tokens aren't a suffix."""
    primary = tokens.split(",")[0]
    label = (addr_label or "").strip()
    if primary and label.endswith(primary):
        return label[: -len(primary)].strip(" .,") or label
    return label


class _Hit:
    __slots__ = ("source_id", "tokens", "addr_label", "item_kind", "score")

    def __init__(self, source_id: str, tokens: str, addr_label: str, item_kind: str, score: float):
        self.source_id = source_id
        self.tokens = tokens
        self.addr_label = addr_label
        self.item_kind = item_kind
        self.score = score


async def _await_embedding(
    question: str,
    embedder: Any,
    precomputed_query_embedding_task: Any | None,
) -> list[float] | None:
    if precomputed_query_embedding_task is not None:
        try:
            return await precomputed_query_embedding_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    try:
        return await embedder.embed_query(question)
    except Exception as exc:  # noqa: BLE001
        log.warning("locate_embed_failed", error=str(exc))
        return None


async def _resolve_attribution_hits(
    matches: list[AttributionMatch],
    *,
    chunk_repo: Any,
    library_repo: Any,
    lang: str,
    titles_cache: _TitlesCache,
) -> list[_Hit]:
    """Turn matched attribution refs into hits. `title` refs resolve via
    library_titles (composite "<source>/<tokens>"); `verse` refs via the
    chunk repo (gives source_id/tokens/addr_label)."""
    hits: list[_Hit] = []
    refs = list(chain.from_iterable(m.refs for m in matches))
    score = max((m.score for m in matches), default=0.85)
    for ref in refs:
        if ref.ref_kind == "title":
            sid, _, tok = ref.target_id.partition("/")
            if not sid or not tok:
                continue
            titles = await _titles_for(library_repo, sid, lang, titles_cache)
            title = titles.get(tok, "")
            hits.append(_Hit(sid, tok, title, "title", score))
        elif ref.ref_kind == "verse" and chunk_repo is not None:
            # User-lang first, fall back to any lang only when the verse has
            # no rows in the user's language. Forcing lang=None leaked the
            # EN addr_label ("CC Madhya") into ru ChapterCards even when a
            # ru row ("ЧЧ Мадхйа") existed — mirror the fallback already in
            # build_pinned_chapter_notes.
            try:
                chunks = await chunk_repo.get_chunks_by_target(
                    ref_kind="verse", target_id=ref.target_id, lang=lang,
                )
                if not chunks:
                    chunks = await chunk_repo.get_chunks_by_target(
                        ref_kind="verse", target_id=ref.target_id, lang=None,
                    )
            except Exception as exc:  # noqa: BLE001
                log.warning("locate_verse_ref_failed", target_id=ref.target_id, error=str(exc))
                continue
            for c in chunks:
                hits.append(_Hit(c.source_id, c.tokens, c.addr_label, "verse", score))
    return hits


# Title-map memo type: (source_id, lang) → {chapter_token: title}. The cache
# is created PER CALL (one dict per run_locate / build_pinned_chapter_notes
# invocation) and threaded through the helpers — never a process-global. The
# old global was keyed by `id(library_repo)`, which CPython can reuse after GC,
# risking a cross-call collision, and was mutated from two entry points.
_TitlesCache = dict[tuple[str, str], dict[str, str]]


async def _titles_for(
    library_repo: Any, source_id: str, lang: str, cache: _TitlesCache,
) -> dict[str, str]:
    """Memoized title map for one book within a single call. `cache` is the
    per-call dict the caller owns; no process-global state."""
    if library_repo is None:
        return {}
    key = (source_id, lang)
    cached = cache.get(key)
    if cached is not None:
        return cached
    titles = await library_repo.fetch_titles(source_id, lang=lang)
    cache[key] = titles
    return titles


async def build_pinned_chapter_notes(
    refs: list[AttributionRef],
    *,
    chunk_repo: Any,
    library_repo: Any,
    lang: str,
    alias_map: Any,
    score: float,
) -> list[dict]:
    """Build chapter-location notes for a pinned attribution that carries a
    `title` ref — the SAME ChapterCard the locate intent renders, reached now
    from the research SHORT path so a curated chapter shows as a chapter (not a
    dropped no-op). Returns [] when there is no title ref or it can't resolve.

    Builds region hits from the title ref (chapter heading via `fetch_titles`)
    plus the verse refs in the same attribution. The verses are resolved in the
    USER's language and fed FIRST so their `_short_name` ("ЧЧ Мадхйа") wins the
    book-level region label over the title hit (whose addr_label is the chapter
    heading itself) — locate's own `_resolve_attribution_hits` forces lang=None
    for cross-lingual locate, which would leak the EN "CC Madhya". The verses
    are NOT emitted as notes here — the SHORT path already renders them as verse
    cards; this adds only the chapter card on top."""
    if library_repo is None or not any(r.ref_kind == "title" for r in refs):
        return []

    # Per-call title memo — no process-global (see `_titles_for`).
    titles_cache: _TitlesCache = {}

    title_hits: list[_Hit] = []
    for ref in refs:
        if ref.ref_kind != "title":
            continue
        sid, _, tok = ref.target_id.partition("/")
        if not sid or not tok:
            continue
        titles = await _titles_for(library_repo, sid, lang, titles_cache)
        title_hits.append(_Hit(sid, tok, titles.get(tok, ""), "title", score))
    if not title_hits:
        return []

    # Verse refs → region-label source only, resolved in the user's lang
    # (fallback to any lang) so the book name renders in the right script.
    verse_hits: list[_Hit] = []
    if chunk_repo is not None:
        for ref in refs:
            if ref.ref_kind != "verse":
                continue
            try:
                chunks = await chunk_repo.get_chunks_by_target(
                    ref_kind="verse", target_id=ref.target_id, lang=lang,
                )
                if not chunks:
                    chunks = await chunk_repo.get_chunks_by_target(
                        ref_kind="verse", target_id=ref.target_id, lang=None,
                    )
            except Exception as exc:  # noqa: BLE001 — label enrichment is best-effort
                log.warning(
                    "pinned_chapter_verse_ref_failed",
                    target_id=ref.target_id, error=str(exc),
                )
                continue
            for c in chunks:
                verse_hits.append(_Hit(c.source_id, c.tokens, c.addr_label, "verse", score))

    # Verse hits first → their book-level short-name wins the region label.
    regions = await _build_regions(
        verse_hits + title_hits, library_repo=library_repo, lang=lang,
        titles_cache=titles_cache,
    )
    notes: list[dict] = []
    for region in regions:
        if not region.chapters:
            continue
        ref_int = alias_map.alias_chapter(
            region.source_id,
            region.region_token,
            region.region_label,
            [(c.tokens, c.title) for c in region.chapters],
        )
        chapter_list = ", ".join(c.tokens for c in region.chapters)
        label = region.region_label or chapter_list
        notes.append({
            "type": "location",
            "ref": ref_int,
            "text": f"{label} — глава {chapter_list}".strip(" —"),
        })
    return notes


def _decide_verse_granularity(
    question: str, chapter_hits: list[_Hit], verse_hits: list[_Hit],
) -> bool:
    """True → answer at verse granularity. Question wording wins; absent a
    cue, fall back to "few verses in a single chapter"."""
    if _VERSE_CUE.search(question):
        return True
    if _CHAPTER_CUE.search(question):
        return False
    distinct_chapters = {(h.source_id, h.tokens.rsplit(".", 1)[0]) for h in verse_hits}
    distinct_verses = {(h.source_id, h.tokens) for h in verse_hits}
    return len(distinct_chapters) <= 1 and 0 < len(distinct_verses) <= 3


async def run_locate(
    question: str,
    lang: str,
    router_args: dict[str, Any],
    *,
    chunk_repo: Any,
    embedder: Any,
    pool: Any = None,
    llm: Any = None,
    embed_model: str | None = None,
    embed_dim: int | None = None,
    library_repo: Any = None,
    request_id: str | None = None,
    on_event: OnEvent | None = None,
    precomputed_query_embedding_task: Any | None = None,
) -> LocateResult:
    """Locate a topic/story in the scripture structure. See module docstring."""
    # Per-call title memo — created fresh each invocation and threaded into
    # every helper, so there's no process-global keyed by a reusable id().
    titles_cache: _TitlesCache = {}
    # Chunk-side spelling only: a short code ("SB") matches no row, so it is
    # dropped and every book is searched (the located region keeps its real
    # source via grouping, so a named book still surfaces correctly). The router
    # now resolves the code before this runs, so a named book usually DOES
    # narrow the search — this stays as the floor, not the plan.
    book_id = chunk_source_filter(router_args.get("source_id"))

    embedding = await _await_embedding(question, embedder, precomputed_query_embedding_task)
    if embedding is None:
        return LocateResult()

    matched_ids: list[str] = []
    attr_hits: list[_Hit] = []

    # (a) Curated attributions — strongest signal for narrative scope.
    # Query BOTH pinned- and boost-kind attributions: locate stories are
    # curated as boost/topical entries ("История Махараджи Прахлады"), while
    # pinned-kind covers "where is verse X" phrasings. Querying only one kind
    # silently drops the other half of the curated corpus.
    if pool is not None and embed_model is not None and embed_dim is not None:
        async def _lookup(kind: str) -> list[AttributionMatch]:
            # Lower the boost accept bar for locate (see _LOCATE_BOOST_ACCEPT_*).
            extra: dict = {}
            if kind == "boost":
                extra = {
                    "accept_native": _LOCATE_BOOST_ACCEPT_NATIVE,
                    "accept_cross": _LOCATE_BOOST_ACCEPT_CROSS,
                }
            try:
                return await asyncio.wait_for(
                    find_attributions(
                        kind=kind, user_q_embedding=embedding, lang=lang,
                        embed_model=embed_model, embed_dim=embed_dim, pool=pool,
                        # locate has no reranker wired — the border gate falls
                        # back to the LLM judge, now fed the real query text.
                        user_query=question if kind == "pinned" else None,
                        llm=llm if kind == "pinned" else None,
                        **extra,
                    ),
                    timeout=TIMEOUT_QUESTION_LOOKUP_S,
                )
            except (asyncio.TimeoutError, Exception) as exc:  # noqa: BLE001
                log.warning(
                    "locate_attribution_failed", kind=kind,
                    error=str(exc), request_id=request_id,
                )
                return []

        q_matches, t_matches = await asyncio.gather(_lookup("pinned"), _lookup("boost"))
        matches = list(q_matches) + list(t_matches)
        if matches:
            matched_ids = [m.attribution_id for m in matches]
            attr_hits = await _resolve_attribution_hits(
                matches, chunk_repo=chunk_repo, library_repo=library_repo, lang=lang,
                titles_cache=titles_cache,
            )

    # (b)+(c) Semantic search over title + verse + commentary kinds.
    sem_hits: list[_Hit] = []
    if chunk_repo is not None:
        try:
            scored = await asyncio.wait_for(
                chunk_repo.search_library_by_embedding(
                    embedding,
                    kinds=["title", "verse", "commentary"],
                    source_id=book_id,
                    lang=lang,
                    top_k=16,
                ),
                timeout=TIMEOUT_FANOUT_S,
            )
        except (asyncio.TimeoutError, Exception) as exc:  # noqa: BLE001
            log.warning("locate_search_failed", error=str(exc), request_id=request_id)
            scored = []
        for s in scored:
            if (s.score or 0.0) < _SCORE_FLOOR:
                continue
            c = s.chunk
            sem_hits.append(_Hit(c.source_id, c.tokens, c.addr_label, c.item_kind, s.score))

    # A matched curated attribution defines the AUTHORITATIVE scope of the
    # story — use ONLY its hits. Merging semantic hits in pollutes the clean
    # curated chapter list (e.g. a stray 7.13 leaking into Prahlāda's
    # 7.1–7.10). Semantic search is the fallback ONLY when no attribution
    # matched.
    all_hits = attr_hits if attr_hits else sem_hits
    if not all_hits:
        return LocateResult(matched_attribution_ids=matched_ids)

    verse_hits = [h for h in all_hits if h.item_kind in ("verse", "commentary")]

    # Granularity: verse-level vs chapter-level.
    if verse_hits and _decide_verse_granularity(question, [], verse_hits):
        seen: set[tuple[str, str]] = set()
        verses: list[LocateVerse] = []
        for h in sorted(verse_hits, key=lambda x: x.score, reverse=True):
            key = (h.source_id, h.tokens)
            if key in seen:
                continue
            seen.add(key)
            verses.append(LocateVerse(h.source_id, h.tokens, h.addr_label, h.score))
            if len(verses) >= _MAX_VERSES:
                break
        return LocateResult(verses=verses, matched_attribution_ids=matched_ids)

    regions = await _build_regions(
        all_hits, library_repo=library_repo, lang=lang, titles_cache=titles_cache,
    )
    truncated = len(regions) > _MAX_REGIONS
    return LocateResult(
        regions=regions[:_MAX_REGIONS],
        truncated=truncated,
        matched_attribution_ids=matched_ids,
    )


async def _build_regions(
    hits: list[_Hit], *, library_repo: Any, lang: str, titles_cache: _TitlesCache,
) -> list[LocateRegion]:
    """Group hits into chapter regions, book-aware. A region is a canto
    (3-level books) or the book itself (2-level books like BG)."""
    # region key → {label, score, chapters: {chapter_token: (title, score)}}
    regions: dict[tuple[str, str], dict[str, Any]] = {}

    for h in hits:
        titles = await _titles_for(library_repo, h.source_id, lang, titles_cache)
        has_cantos = any("." in t for t in titles.keys())
        segs = h.tokens.split(",")[0].split(".")
        if h.item_kind == "title":
            # A title hit is already a chapter (or canto) address.
            chapter_token = h.tokens.split(",")[0]
            if has_cantos and len(chapter_token.split(".")) == 1:
                # Canto-only title — not a chapter; skip for the chapter list.
                continue
        elif has_cantos:
            chapter_token = ".".join(segs[:2]) if len(segs) >= 2 else segs[0]
        else:
            chapter_token = segs[0]

        if has_cantos:
            canto = chapter_token.split(".")[0]
            region_token = canto
            region_label = titles.get(canto) or _short_name(h.addr_label, h.tokens)
        else:
            region_token = ""  # book-level region
            region_label = _short_name(h.addr_label, h.tokens)

        rkey = (h.source_id, region_token)
        region = regions.setdefault(
            rkey, {"label": region_label, "score": 0.0, "chapters": {}}
        )
        if region_label and not region["label"]:
            region["label"] = region_label
        region["score"] = max(region["score"], h.score)
        chapter_title = titles.get(chapter_token) or _short_name(h.addr_label, h.tokens)
        prev = region["chapters"].get(chapter_token)
        if prev is None or prev[1] < h.score:
            region["chapters"][chapter_token] = (chapter_title, h.score)

    out: list[LocateRegion] = []
    for (source_id, region_token), region in regions.items():
        chapters = tuple(
            LocateChapter(tok, title)
            for tok, (title, _score) in sorted(
                region["chapters"].items(), key=lambda kv: _numeric_key(kv[0])
            )
        )
        out.append(LocateRegion(
            source_id=source_id,
            region_token=region_token,
            region_label=region["label"],
            chapters=chapters,
            score=region["score"],
        ))
    out.sort(key=lambda r: r.score, reverse=True)
    return out

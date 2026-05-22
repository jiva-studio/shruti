"""commentary_expansion — when a verse appears in the research result,
pull every commentary anchored on that verse (all authors) and append
them as supplementary context for the synthesizer.

Verses found by ANN don't carry their authored commentaries with them
automatically — the LLM ends up answering about БГ 2.13 without
Prabhupada's purport or Vishvanatha's tika as grounding. This helper
closes that gap by doing one extra round of address-keyed lookups
after the main fanout.

Operates on already-built envelopes (post-`library_to_envelope`) so it
sits cleanly between fanout and `ResearchResult` construction, doesn't
touch domain entities, and is trivially unit-testable.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from shruti_chat.agent.tools._envelope import library_to_envelope
from shruti_chat.domain.entities import LibraryChunk
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.constants import MAX_COMMENTARIES_PER_VERSE


log = get_logger(__name__)

OnEvent = Callable[[str, dict[str, Any]], None]


def _emit_commentary_source(on_event: OnEvent | None, chunk: LibraryChunk) -> None:
    """Mirror `_emit_source_for_ref` in pipeline.py so the mobile progress
    panel lists pulled commentaries alongside the fanout sources."""
    if on_event is None:
        return
    try:
        on_event(
            "research_source",
            {
                "kind": "commentary",
                "id": f"library:{chunk.item_id}",
                "label": chunk.addr_label,
            },
        )
    except Exception:  # noqa: BLE001 — observability must never break research
        log.warning("on_event_commentary_source_failed", item_id=chunk.item_id)


async def _fetch_one(
    chunk_repo: Any,
    *,
    source_id: str,
    tokens: str,
    lang: str | None,
) -> list[LibraryChunk]:
    """Single (source_id, tokens) → commentary chunks, with native-lang
    fallback identical to `_fetch_refs` in pipeline.py."""
    try:
        chunks = await chunk_repo.get_chunks_by_verse(
            source_id=source_id, tokens=tokens, kinds=["commentary"], lang=lang,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "expand_commentaries_lookup_failed",
            source_id=source_id, tokens=tokens, error=str(exc),
        )
        return []
    if not chunks and lang is not None:
        try:
            chunks = await chunk_repo.get_chunks_by_verse(
                source_id=source_id, tokens=tokens, kinds=["commentary"], lang=None,
            )
        except Exception:  # noqa: BLE001
            chunks = []
    return chunks


def _select_capped(
    chunks: list[LibraryChunk],
    *,
    cap: int,
) -> list[LibraryChunk]:
    """Pick at most `cap` chunks, prioritising one segment per distinct
    author_id first (round-robin order preserved), then filling the rest
    with the remaining segments. Keeps wide author coverage on a verse
    that has many purports."""
    if cap <= 0 or not chunks:
        return []
    first_pass: list[LibraryChunk] = []
    leftover: list[LibraryChunk] = []
    seen_authors: set[str | None] = set()
    for c in chunks:
        if c.author_id in seen_authors:
            leftover.append(c)
        else:
            seen_authors.add(c.author_id)
            first_pass.append(c)
    selected = first_pass[:cap]
    if len(selected) < cap:
        selected.extend(leftover[: cap - len(selected)])
    return selected


async def expand_verses_with_commentaries(
    envelopes: list[dict[str, Any]],
    *,
    chunk_repo: Any,
    alias_map: Any,
    lang: str | None,
    catalog_repo: Any | None = None,
    max_commentaries_per_verse: int = MAX_COMMENTARIES_PER_VERSE,
    on_event: OnEvent | None = None,
) -> list[dict[str, Any]]:
    """For each verse envelope in `envelopes`, pull all commentaries on
    that verse (all authors) and return them as new commentary envelopes.

    Caller is responsible for appending the result to its chunk list.
    Input `envelopes` is read-only — never mutated.

    Dedup: commentaries already present in `envelopes` (e.g. surfaced by
    ANN on their own) are skipped. Commentary chunks appearing under
    multiple input verses are emitted once.

    Score: parent verse's score minus 0.05 — keeps the commentary just
    below its anchor in the ranked list while staying above the 0.45
    relevance floor for any real verse hit. Verses without a numeric
    score fall back to 0.5.
    """
    verse_pairs: dict[tuple[str, str], float] = {}
    seen_commentary: set[tuple[str, int]] = set()

    for env in envelopes:
        if not isinstance(env, dict):
            continue
        env_type = env.get("type")
        meta = env.get("meta") or {}
        if env_type == "verse":
            source_id = meta.get("source_id")
            tokens = meta.get("tokens")
            if not source_id or not tokens:
                continue
            score = env.get("score") if isinstance(env.get("score"), (int, float)) else None
            parent_score = float(score) if score is not None else 0.5
            key = (source_id, tokens)
            prev = verse_pairs.get(key)
            if prev is None or prev < parent_score:
                verse_pairs[key] = parent_score
        elif env_type == "commentary":
            item_id = meta.get("item_id") or env.get("ref")
            seg = meta.get("segment_index", 0)
            if item_id is not None:
                seen_commentary.add((str(item_id), int(seg or 0)))

    if not verse_pairs:
        return []

    pairs = list(verse_pairs.items())
    chunk_lists = await asyncio.gather(
        *(
            _fetch_one(chunk_repo, source_id=sid, tokens=tok, lang=lang)
            for (sid, tok), _score in pairs
        )
    )

    out: list[dict[str, Any]] = []
    pending: list[LibraryChunk] = []
    pending_score: list[float] = []
    for ((_sid, _tok), parent_score), chunks in zip(pairs, chunk_lists):
        if not chunks:
            log.info("expand_commentaries_empty", source_id=_sid, tokens=_tok)
            continue
        capped = _select_capped(chunks, cap=max_commentaries_per_verse)
        child_score = max(0.0, parent_score - 0.05)
        for c in capped:
            dedup_key = (c.item_id, c.segment_index or 0)
            if dedup_key in seen_commentary:
                continue
            seen_commentary.add(dedup_key)
            pending.append(c)
            pending_score.append(child_score)

    # Batch-resolve human author names so the synthesizer can render
    # "БГ 2.13 — комментарий А.Ч. Бхактиведанты Свами Прабхупады"
    # instead of three identically-headed "БГ 2.13" blocks the LLM
    # can't tell apart. Best-effort: if the catalog lookup fails for
    # any reason we still emit envelopes — the raw author_id stays in
    # meta and the synth falls back to it.
    author_names: dict[str, str] = {}
    if catalog_repo is not None and lang:
        ids_to_resolve = [c.author_id for c in pending if c.author_id]
        if ids_to_resolve:
            try:
                author_names = await catalog_repo.get_author_names(
                    ids_to_resolve, lang=lang,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "expand_commentaries_author_resolve_failed",
                    error=str(exc),
                )
                author_names = {}

    for c, child_score in zip(pending, pending_score):
        env = library_to_envelope(c, alias_map=alias_map, score=child_score)
        if c.author_id and c.author_id in author_names:
            meta = env.get("meta") or {}
            meta["author_name"] = author_names[c.author_id]
            env["meta"] = meta
        out.append(env)
        _emit_commentary_source(on_event, c)
    return out

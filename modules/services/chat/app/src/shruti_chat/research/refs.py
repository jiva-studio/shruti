"""Attribution refs: resolve curated refs into citable envelopes, and gate them."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

from shruti_chat.agent.tools.envelope import (
    lecture_to_envelope,
    library_to_envelope,
    resolve_commentary_author_names,
)
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.constants import BOOST_REF_RERANK_ACCEPT
from shruti_chat.research.corpus_fanout import OnEvent, emit_library_research_source
from shruti_chat.research.models import AttributionRef

log = get_logger(__name__)


def dedupe_refs(refs: list[AttributionRef]) -> list[AttributionRef]:
    seen: set[tuple[str, str]] = set()
    out: list[AttributionRef] = []
    for r in refs:
        key = (r.ref_kind, r.target_id)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


async def fetch_refs(
    refs: list[AttributionRef],
    *,
    chunk_repo: Any,
    alias_map: Any,
    lang: str | None,
    canonical_score: float,
    on_event: OnEvent | None = None,
    library_repo: Any | None = None,
    catalog_repo: Any | None = None,
    author_scope: Any | None = None,
) -> list[dict[str, Any]]:
    """Resolve each AttributionRef → chunks → envelopes. Envelopes carry
    `score = canonical_score` (>= 0.85 for accept) so the synthesizer's
    refusal-discipline doesn't drop them as junk.

    For lectures, ref_kind="document" with kind='letter' / 'commentary' /
    'prose_chapter' applies; refs to literal verses use kind='verse'."""
    if not refs:
        return []

    # Every attribution path — the question lookup, the memory pass and the
    # topic refs — resolves its refs HERE, which makes this the one place the
    # author selection has to be applied to them. A pinned lecture is still a
    # lecture: it arrives by a verse↔talk link rather than a search, so it
    # bypasses every eligible-id filter upstream. Only `ref_kind == "track"` is
    # touched; verses, purports and chapters are canon.
    if author_scope is not None and author_scope.selection.constrained:
        allowed = await author_scope.track_ids()
        allowed_set = set(allowed or ())
        kept = []
        for ref in refs:
            if ref.ref_kind != "track":
                kept.append(ref)
                continue
            # target_id is "<track_id>@<start_ms>-<end_ms>".
            if ref.target_id.split("@", 1)[0] in allowed_set:
                kept.append(ref)
        if len(kept) != len(refs):
            log.info(
                "attribution_refs_narrowed_by_author",
                dropped=len(refs) - len(kept), kept=len(kept),
            )
        refs = kept
        if not refs:
            return []

    async def _one(ref: AttributionRef) -> list[dict[str, Any]]:
        # Lecture-fragment refs resolve to transcript chunks (which have no
        # item_id/addr_label), so they take the lecture envelope path, not the
        # library one. target_id = "<track_id>@<start_ms>-<end_ms>".
        if ref.ref_kind == "track":
            return await _one_track(ref)
        try:
            chunks = await chunk_repo.get_chunks_by_target(
                ref_kind=ref.ref_kind, target_id=ref.target_id, lang=lang,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "fetch_refs_lookup_failed",
                ref_kind=ref.ref_kind, target_id=ref.target_id, error=str(exc),
            )
            return []
        # Native-lang fallback: if no chunks in user's lang, retry without
        # the filter so authoritative refs still surface for cross-lang users.
        if not chunks and lang is not None:
            try:
                chunks = await chunk_repo.get_chunks_by_target(
                    ref_kind=ref.ref_kind, target_id=ref.target_id, lang=None,
                )
            except Exception:  # noqa: BLE001
                chunks = []
        # Resolve commentary author_id → human name (e.g. "A. C. Bhaktivedanta
        # Swami Prabhupada") so a pinned commentary's blockquote carries its
        # author, not just the address, as the fanout + commentary_expansion
        # paths do. Best-effort (empty map when no catalog / non-commentary
        # chunks).
        author_names = await resolve_commentary_author_names(
            chunks, catalog_repo=catalog_repo, lang=lang,
        )

        def _author_meta(c: Any) -> dict[str, Any] | None:
            name = author_names.get(c.author_id) if c.author_id else None
            return {"author_name": name} if name else None

        # Document refs (commentary / prose_chapter / letter): cite the
        # WHOLE document as ONE source, from its canonical library.db body —
        # NOT reassembled from the overlapping Postgres search chunks (which
        # repeat text at segment boundaries and, for some imports, carry
        # duplicated paragraphs). Falls back to the chunk path if the body
        # isn't available. Verse refs always take the chunk path.
        if ref.ref_kind == "document" and library_repo is not None and chunks:
            head = chunks[0]
            body = await library_repo.fetch_document_body(head.item_id, lang or head.lang)
            if body:
                emit_library_research_source(on_event, item_kind=head.item_kind, chunk=head)
                full = replace(head, text=body, segment_index=0)
                env = library_to_envelope(
                    full, alias_map=alias_map, score=canonical_score,
                    extra_meta=_author_meta(head),
                )
                env["_dedup_key"] = (head.item_kind, head.item_id, 0)
                return [env]

        envelopes: list[dict[str, Any]] = []
        for c in chunks:
            # Surface the consulted source with its real (normalized) label
            # now that the chunk — and its addr_label — has loaded. Shares
            # the `verse:`/`library:` id namespace with the fanout path, so
            # the client's dedup-by-id collapses a source seen by both.
            emit_library_research_source(on_event, item_kind=c.item_kind, chunk=c)
            env = library_to_envelope(
                c, alias_map=alias_map, score=canonical_score,
                extra_meta=_author_meta(c),
            )
            # Same shape as fanout's _library_dedup_key so merge_fanout-style
            # callers can dedup these alongside fanout output.
            env["_dedup_key"] = (c.item_kind, c.item_id, c.segment_index)
            envelopes.append(env)
        return envelopes

    async def _one_track(ref: AttributionRef) -> list[dict[str, Any]]:
        try:
            chunks = await chunk_repo.get_chunks_by_track_fragment(
                target_id=ref.target_id, lang=lang,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "fetch_refs_track_failed",
                target_id=ref.target_id, error=str(exc),
            )
            return []
        # Native-lang fallback, mirroring the library path above.
        if not chunks and lang is not None:
            try:
                chunks = await chunk_repo.get_chunks_by_track_fragment(
                    target_id=ref.target_id, lang=None,
                )
            except Exception:  # noqa: BLE001
                chunks = []
        envelopes: list[dict[str, Any]] = []
        for c in chunks:
            # lecture_to_envelope mints the cite alias the client dedups on.
            # _dedup_key mirrors corpus_fanout's _lecture_dedup_key shape so
            # merge_fanout collapses a fragment surfaced by both attribution
            # and fanout (the helper is private to corpus_fanout, so inline).
            env = lecture_to_envelope(c, alias_map=alias_map, score=canonical_score)
            env["_dedup_key"] = ("lecture", c.track_id, c.start_ms, c.end_ms)
            envelopes.append(env)
        return envelopes

    per_ref = await asyncio.gather(*(_one(r) for r in refs), return_exceptions=False)
    flat: list[dict[str, Any]] = []
    for batch in per_ref:
        flat.extend(batch)

    # Title refs are intentionally NOT surfaced as a chapter card here: the
    # ChapterCard renders poorly on mobile and the chapter pointer adds noise
    # to the answer. The title→chapter resolver (`build_pinned_chapter_notes`)
    # is kept for potential reuse, but a pinned `title` ref is a no-op in the
    # research path — only its verse refs render (as verse cards). Verse refs in
    # the same attribution still come from the per-ref loop above.

    return flat


async def gate_topic_refs(
    envelopes: list[dict[str, Any]],
    *,
    reranker: Any,
    question: str,
    request_id: str | None,
) -> list[dict[str, Any]]:
    """Cross-encoder gate for fetched boost (topic-attribution) refs.

    boost refs are pinned at a flat 0.75 cosine that floats them above
    ordinary fanout, but — unlike the fanout pool — they never go through the
    reranker. A topic that matched only a tangential angle of the question
    therefore gets seated above on-topic fanout chunks. When a reranker is
    present, re-score each ref's TEXT against the USER QUESTION and drop the
    ones below `BOOST_REF_RERANK_ACCEPT`. Survivors keep their 0.75 `score`
    (so the downstream two-tier sort is unchanged for the kept set).

    Conservative by construction: no reranker, no usable texts, or a reranker
    error all pass the refs through untouched — the normal fanout path is
    never touched, and a gate failure can only ADD refs back, never silently
    drop a curated decision on infra trouble.
    """
    if reranker is None or not envelopes:
        return envelopes
    texts = [(e.get("text") or "").strip() for e in envelopes]
    if not any(texts):
        return envelopes
    try:
        scored = await reranker.rerank(question, texts)
    except Exception as exc:  # noqa: BLE001 — a turn never fails on the reranker
        log.warning("topic_ref_rerank_failed", error=str(exc), request_id=request_id)
        return envelopes
    score_by_idx = {idx: rs for idx, rs in scored}
    kept: list[dict[str, Any]] = []
    for i, env in enumerate(envelopes):
        rs = score_by_idx.get(i)
        # An index the reranker omitted (its own top_k) is treated as below
        # the bar — it ranked outside the kept set.
        if rs is not None and rs >= BOOST_REF_RERANK_ACCEPT:
            kept.append(env)
    log.info(
        "topic_refs_gated",
        request_id=request_id,
        before=len(envelopes),
        after=len(kept),
    )
    return kept

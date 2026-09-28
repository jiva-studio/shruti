"""Curated memories: find the one that answers this turn and fold it onto the result."""

from __future__ import annotations

from typing import Any

from shruti_chat.observability.logging import get_logger
from shruti_chat.research.attribution_lookup import find_attributions
from shruti_chat.research.constants import MEMORY_REF_SCORE
from shruti_chat.research.corpus_fanout import OnEvent
from shruti_chat.research.models import AttributionMatch, MemoryResolution, ResearchResult
from shruti_chat.research.refs import fetch_refs

log = get_logger(__name__)


async def resolve_memory(
    *,
    user_q_embedding: list[float],
    sub_query_texts: list[str],
    embedder: Any,
    retrieval_lang_code: str,
    answer_lang: str,
    chunk_repo: Any,
    alias_map: Any,
    library_repo: Any | None,
    catalog_repo: Any | None,
    on_event: OnEvent | None,
    user_query: str = "",
    reranker: Any = None,
    llm: Any = None,
    confirm_model: str | None = None,
    author_scope: Any | None = None,
) -> MemoryResolution:
    """Find the best-matching memory for this turn and resolve it.

    The lookup runs against the raw query AND each planner sub-query, taking the
    best match. A paraphrase the raw query embeds too far from a trigger ("how
    is the Gita organised") often decomposes into a sub-query ("structure of the
    Bhagavad-gita")
    that matches the trigger strongly — so this widens recall WITHOUT authoring a
    trigger per phrasing, and lifts borderline matches clear of the accept floor.

    The note is injected as non-citable background context; the refs (scoped to
    the answer language) are resolved into citable envelopes folded into the
    pool like boost. The match `score`/`stage` ride along so the sufficiency
    gate can require a STRONGER signal to short-circuit the sweep than the
    (loose) inject threshold. Best-effort — returns an empty `MemoryResolution`
    on no match."""
    if chunk_repo is None:
        return MemoryResolution()

    embeddings: list[list[float]] = [user_q_embedding]
    if sub_query_texts and embedder is not None:
        try:
            embeddings.extend(await embedder.embed_queries(sub_query_texts))
        except Exception as exc:  # noqa: BLE001 — best-effort
            log.warning("memory_subquery_embed_failed", error=str(exc))

    top: AttributionMatch | None = None
    for emb in embeddings:
        matches = await find_attributions(
            kind="memory", user_q_embedding=emb, lang=retrieval_lang_code,
            chunk_repo=chunk_repo, reranker=reranker, user_query=user_query,
            llm=llm, confirm_model=confirm_model,
        )
        if matches and (top is None or matches[0].score > top.score):
            top = matches[0]
    if top is None:
        return MemoryResolution()
    note = await chunk_repo.fetch_attribution_note(
        top.attribution_id, lang=retrieval_lang_code,
    )
    # Keep refs that are language-agnostic OR scoped to this answer language
    # (e.g. drop the EN lecture ref when answering in RU).
    scoped_refs = [r for r in top.refs if not r.language or r.language == answer_lang]
    envelopes: list[dict[str, Any]] = []
    if scoped_refs:
        envelopes = await fetch_refs(
            scoped_refs, chunk_repo=chunk_repo, alias_map=alias_map,
            lang=retrieval_lang_code, canonical_score=MEMORY_REF_SCORE, on_event=on_event,
            library_repo=library_repo, catalog_repo=catalog_repo,
            author_scope=author_scope,
        )
    log.info(
        "pipeline_memory_match",
        attribution_id=top.attribution_id,
        score=round(top.score, 3),
        stage=top.stage,
        has_note=note is not None,
        refs=len(envelopes),
    )
    return MemoryResolution(
        note=note,
        attribution_id=top.attribution_id,
        envelopes=envelopes,
        score=top.score,
        stage=top.stage,
    )


def attach_memory(result: ResearchResult, mem: MemoryResolution) -> ResearchResult:
    """Fold a resolved memory onto a ResearchResult: the note rides as
    non-citable background; the refs are AUTHORITATIVE.

    A memory's refs are curator-picked (a human deliberately selected exactly
    these shlokas for exactly this note), so they ride with `authoritative_refs`
    — pinned ahead of the reranked fanout pool — rather than being thrown into
    the pool and reranked against ordinary chunks where the planner can drop
    them. The note builds the theses; these refs are their intended evidence."""
    result.memory_note = mem.note
    result.matched_memory_id = mem.attribution_id
    if mem.envelopes:
        result.authoritative_refs = list(result.authoritative_refs) + mem.envelopes
    return result

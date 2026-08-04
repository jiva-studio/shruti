"""Synthesis planner node — runs `outline_builder.build_outline` on the
notes accumulated by the research worker, writes the resulting `Outline`
(or `None`) back into state.

Sits BETWEEN `research_worker` and `synthesizer`. The synthesizer then
reads `state["outline"]` and switches its prompt accordingly:

- `outline = None`             → free-form synthesis (legacy behaviour)
- `Outline(theses=[])`         → deliberate refusal
- `Outline(theses=[…])`        → plan-driven prose (one paragraph per
                                  thesis, citing only its supporting_notes)

The node always runs — there's no feature flag — but a missing
`llm_synthesis_planner` setting, an LLM failure, or empty `tool_results`
all degrade gracefully to `outline=None`. This means the synthesizer's
legacy code path is reachable in every failure mode without any explicit
fallback wiring elsewhere.
"""

from __future__ import annotations

import asyncio

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._lang_name import resolve_lang_name
from lectorium_chat.agent.graph.nodes._worker_common import (
    flush_card_payloads,
    translate_commentaries,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.config import get_settings
from lectorium_chat.observability.langfuse_client import langfuse_node_callback, langfuse_span
from lectorium_chat.observability.logging import bind_node_role, get_logger
from lectorium_chat.research.commentary_expansion import (
    rerank_and_attach_commentaries,
)
from lectorium_chat.research.outline_builder import (
    _MIN_THESES_FOR_INTRO,
    build_outline,
    synthesize_intro,
)
from lectorium_chat.research.pipeline import resolve_retrieval_lang
from lectorium_chat.research.thesis_augmentation import augment_thin_theses


log = get_logger(__name__)


def _fallback_enabled(state: ChatState, ctx: TurnContext | None = None) -> bool:
    """Whether the out-of-corpus memory-pass fallback is active this turn.
    Per-turn `body.config.enable_corpus_fallback` overrides the global
    `Settings.enable_corpus_fallback` (same pattern as `enable_planner`).

    Off, additionally, whenever the answer is narrowed to chosen lecturers. The
    memory pass answers from the MODEL's own knowledge, and someone who limited
    the answer to a teacher asked for the opposite of that — they would get
    ungrounded prose under a filter they set, with no way to tell. Then the
    refusal path runs instead, and `_author_note` explains why.
    """
    scope = getattr(ctx, "author_scope", None) if ctx is not None else None
    if scope is not None and scope.selection.constrained:
        return False
    cfg = state.get("config", {}) or {}
    if "enable_corpus_fallback" in cfg:
        return bool(cfg["enable_corpus_fallback"])
    return get_settings().enable_corpus_fallback


async def synthesis_planner_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("synthesis_planner")
    ctx = runtime.context

    # Per-turn experimental toggle from POST /chat body.config. Default
    # True matches prod; clients pass `enable_planner: false` to compare
    # plan-driven vs free-form synthesis on the same retrieval.
    if not state.get("config", {}).get("enable_planner", True):
        log.info("synthesis_planner_disabled_by_config", request_id=ctx.request_id)
        return {"outline": None}

    # ReAct loop appends each tool result as-is, so `tool_results` can
    # contain both flat dicts (single-result tools) AND nested lists
    # (chunks_search / chunks_get_by_address etc., which return list[dict]).
    # The synthesizer flattens in its own formatter; we do the same here
    # so build_outline / Stage 1 / Stage 2 all see uniform list[dict].
    raw_results = state.get("tool_results") or []
    tool_results: list[dict] = []
    for r in raw_results:
        if isinstance(r, list):
            tool_results.extend(x for x in r if isinstance(x, dict))
        elif isinstance(r, dict):
            tool_results.append(r)
    if not tool_results:
        # No notes to plan over — let the synthesizer's existing
        # empty-tool_results handling take over (it already emits the
        # refusal text via `grounding.md` rules).
        log.info(
            "synthesis_planner_skip_no_notes",
            request_id=ctx.request_id,
        )
        # Truly nothing retrieved — a genuine corpus miss. Flag it so
        # `route_after_planner` can hand the turn to the memory-pass
        # fallback instead of a flat refusal.
        return {"outline": None, "corpus_insufficient": _fallback_enabled(state, ctx)}

    if ctx.llm is None:
        log.warning(
            "synthesis_planner_skip_no_llm",
            request_id=ctx.request_id,
        )
        return {"outline": None}

    cb = (
        langfuse_node_callback(ctx.langfuse_trace_id, "synthesis_planner")
        if ctx.langfuse_trace_id
        else None
    )

    # Resolve the human language NAME once and thread it into all three
    # planner-side writers (planner / intro / conclusion). A bare locale
    # code ("sr-Latn") in the `Language:` directive makes the LLM drift to
    # Russian — the synthesizer already fixes this exact drift; the planner
    # writers stream their prose (the intro) to the client WITHOUT a
    # synthesizer re-pass, so the fix must be applied here too.
    lang_name = await resolve_lang_name(ctx, state.get("lang") or "ru")

    # Curator memory note(s) for this turn (set by research_worker). They are
    # AUTHORITATIVE framing — the planner anchors the outline's structure to
    # them (note step → thesis) instead of building sections from whatever the
    # chunk pool happened to cluster into. A list (one element today, since the
    # lookup caps at one memory per turn) so multiple notes compose as separate
    # structured sections if the cap is ever raised.
    memory_note = state.get("memory_note")
    memory_notes = [memory_note] if memory_note and memory_note.strip() else None

    # `model=None` / `conclusion_model=None` lets `prompt_with_fallback`
    # resolve the model from the respective Langfuse prompt-config (set
    # to `llm_synthesis_planner` / `llm_conclusion_writer` at bootstrap
    # time) — same pattern as query_planner / topic_extractor.
    outline = await build_outline(
        state.get("user_query", ""),
        state.get("lang", "ru"),
        tool_results,
        llm=ctx.llm,
        model=None,
        conclusion_model=None,
        callbacks=[cb] if cb is not None else None,
        lang_name=lang_name,
        # Who the lecture notes belong to, when the turn was narrowed to them.
        speaker=(
            ctx.author_scope.selection.names
            if ctx.author_scope is not None and ctx.author_scope.selection.constrained
            else ""
        ),
        memory_notes=memory_notes,
    )

    if outline is None:
        log.info(
            "synthesis_planner_outline_none",
            request_id=ctx.request_id,
            n_notes=len(tool_results),
        )
        return {"outline": None}

    log.info(
        "synthesis_planner_outline_built",
        request_id=ctx.request_id,
        n_notes=len(tool_results),
        n_theses=len(outline.theses),
        n_skipped=len(outline.skipped_notes),
        has_intro=outline.intro is not None,
    )

    # Per-turn cross-encoder kill-switch (Stage B). Off ⇒ pass None so the
    # per-thesis grounding selection runs the cosine path verbatim.
    enable_reranker = state.get("config", {}).get("enable_reranker", True)
    reranker = ctx.reranker if enable_reranker else None
    user_query = state.get("user_query", "")

    # Corpus-constrained retrieval language — the SAME clamp research_worker
    # used. The lazy commentary attach below MUST fetch purports in this
    # (corpus) language, NOT the raw answer language: for a non-corpus answer
    # (uk / sr-*) `state["lang"]` finds no purport and falls back to a stray
    # Russian one. `distinct_langs` is cached, so this is a cache hit.
    retrieval_lang_code = await resolve_retrieval_lang(
        ctx.chunk_repo, state.get("lang") or "ru", request_id=ctx.request_id
    )
    ctx.retrieval_lang_code = retrieval_lang_code

    # Stage 1: lazy commentary attach + per-thesis rerank.
    # Pulls purports ONLY for verses the planner picked, then re-ranks
    # the pool against each thesis text — replaces planner's tentative
    # LLM-attribution with per-thesis ranking (cross-encoder when a
    # reranker is present, else cosine). Graceful degrade: on missing
    # embedder / fetch failure, returns the original outline + no new
    # notes (synthesizer keeps the planner's picks).
    #
    # Kicked off as a TASK so the intro-writer call below overlaps it instead
    # of adding to the critical path. Stage 1 reads outline.theses +
    # tool_results; synthesize_intro reads only outline.theses and mutates
    # nothing — independent, safe to run concurrently.
    stage1_task = asyncio.create_task(rerank_and_attach_commentaries(
        outline,
        tool_results,
        chunk_repo=ctx.chunk_repo,
        embedder=ctx.embedder,
        alias_map=ctx.aliases,
        lang=retrieval_lang_code,
        catalog_repo=ctx.catalog_repo,
        on_event=None,  # planner runs after the live SSE progress panel
        reranker=reranker,
        user_query=user_query,
    ))

    # Intro rewrite, CONCURRENT with Stage 1. The planner's inline intro is a
    # topic table-of-contents (it's generated before the theses exist), so we
    # rewrite it from the finished thesis claims. Because it runs while Stage 1
    # is in flight, the extra LLM call costs ~no wall-clock. Falls back to the
    # planner's intro on failure / empty. Single-thesis answers carry no intro.
    resolved_intro = outline.intro or ""
    if len(outline.theses) >= _MIN_THESES_FOR_INTRO:
        rewritten = await synthesize_intro(
            outline,
            state.get("lang", "ru"),
            llm=ctx.llm,
            model=None,
            callbacks=[cb] if cb is not None else None,
            lang_name=lang_name,
            memory_notes=memory_notes,
        )
        if rewritten:
            resolved_intro = rewritten

    # Early-intro paint: stream the (now claim-bearing) intro the moment it's
    # ready — before the Stage 1/2 grounding finishes — so the answer begins
    # on screen seconds early. The synthesizer is then handed an intro-less
    # plan (intro=None) so it never reproduces it. Marker-free, bypasses the
    # expander safely. Per-turn kill-switch via config.
    intro_streamed = False
    intro_text = resolved_intro.strip()
    # Not under a lecturer filter. There the answer may have to open with the
    # admission that the chosen teachers had nothing (see `_author_note`), and
    # that only reads as an explanation if it comes FIRST — but whether it is
    # needed is not known until the pool is final, after Stage 2. So on those
    # turns the intro goes back to the synthesizer, which renders it after the
    # note. Costs the early-paint head start on a minority of turns; a
    # disclaimer stranded under the paragraph it qualifies costs more.
    narrowed = bool(
        ctx.author_scope is not None and ctx.author_scope.selection.constrained
    )
    if (
        intro_text
        and outline.theses
        and not narrowed
        and state.get("config", {}).get("enable_early_intro", True)
    ):
        try:
            get_stream_writer()(
                {"type": "delta", "data": {"text": intro_text + "\n\n"}}
            )
            intro_streamed = True
            log.info(
                "synthesis_planner_intro_streamed",
                request_id=ctx.request_id,
                chars=len(intro_text),
            )
        except Exception as exc:  # noqa: BLE001 — never break the turn on paint
            log.warning("synthesis_planner_intro_stream_failed", error=str(exc))

    # Stage 1 has been running while the intro was written — collect it now.
    with langfuse_span("planner.stage1_rerank_attach"):
        enriched, new_commentaries = await stage1_task

    # Stage 2: per-thesis thin-support augmentation.
    # For theses still weak after Stage 1 (max cosine < threshold or
    # fewer than 2 strong notes), run a fresh thesis-targeted ANN
    # fetch — respecting the user's router_args filters — and re-rank.
    # Fires conditionally per-thesis; if all are strong, no DB calls.
    with langfuse_span("planner.stage2_augment"):
        augmented, fresh_chunks = await augment_thin_theses(
            enriched,
            list(tool_results) + list(new_commentaries),
            chunk_repo=ctx.chunk_repo,
            embedder=ctx.embedder,
            alias_map=ctx.aliases,
            catalog_repo=ctx.catalog_repo,
            lang=retrieval_lang_code,
            router_args=state.get("extracted_args") or {},
            reranker=reranker,
            user_query=user_query,
            # This stage runs its OWN lecture search, after retrieval is over and
            # outside the pipeline that threads the scope — so it has to be
            # handed the selection here or it tops theses up from every lecturer.
            author_scope=ctx.author_scope,
        )

    # Emit a one-shot summary event so chat_turn can pull outline-shape
    # data into TurnSummary for Langfuse scoring. Custom-event channel —
    # doesn't reach the client (chat_turn filters known event types
    # before yielding to the SSE writer); pure observability plumbing.
    try:
        writer = get_stream_writer()
        n_outline_notes = len(tool_results)
        n_skipped = len(augmented.skipped_notes)
        ratio = (n_skipped / n_outline_notes) if n_outline_notes else 0.0
        writer({
            "type": "outline_summary",
            "data": {
                "n_theses": len(augmented.theses),
                "has_intro": bool(resolved_intro and resolved_intro.strip()),
                "has_conclusion": bool(
                    augmented.conclusion and augmented.conclusion.strip(),
                ),
                "skipped_notes_ratio": round(ratio, 3),
            },
        })
    except Exception as exc:  # noqa: BLE001 — observability never breaks the turn
        log.warning("synthesis_planner_summary_emit_failed", error=str(exc))

    # Stage 1 + Stage 2 mint fresh verse / lecture-fragment aliases
    # (commentary attach, thin-thesis augmentation) AFTER research_worker
    # already flushed its own. Flush again here so those late refs get
    # their `verse` / `cite_transcript` payload BEFORE the synthesizer
    # (the next node) streams the markers that cite them — otherwise the
    # client renders a bare chip with no transcript. The per-turn
    # `emitted_*_refs` dedup means research_worker's refs aren't re-sent.
    await flush_card_payloads(ctx)
    # Translate the purports Stage 1/2 just attached. research_worker only
    # translated the refs that existed when IT ran; the planner's lazy attach
    # adds more AFTER that, so without this they'd stream untranslated. The
    # call is idempotent — refs already translated are skipped — so it only
    # covers the late arrivals. Must finish before the synthesizer streams.
    await translate_commentaries(ctx)

    # Stage 1/2 carried the planner's raw intro through untouched; settle the
    # final intro now. If we painted it early, hand the synthesizer an
    # intro-less plan (intro=None) so it begins at the first thesis and never
    # reproduces it (pure code — `intro=None` is an already-supported shape,
    # no fragile "you already wrote the intro" prompt directive). If we did
    # NOT paint (kill-switch off / empty), give the synthesizer the resolved
    # claim-bearing intro to render itself.
    final_intro = None if intro_streamed else (resolved_intro or None)
    final_outline = augmented.model_copy(update={"intro": final_intro})

    update: dict = {"outline": final_outline}
    # Retrieved notes existed but the planner rejected every one
    # (Outline(theses=[])) — a relevance miss, not a degradation. Flag it
    # for the memory-pass fallback. A non-empty plan clears the flag.
    if not final_outline.theses:
        scope = getattr(ctx, "author_scope", None)
        if scope is not None and scope.private_hits:
            # Their OWN recordings were retrieved for this turn — production
            # printed «Не нашёл в корпусе материалов на эту тему» with fourteen
            # translated fragments of the asked-for teacher attached to it. The
            # planner may well be right that mid-sentence transcript scraps make
            # poor theses, but "nothing found" is then a false statement. Hand the
            # notes to the synthesizer free-form instead of refusing over them.
            log.info(
                "planner_rejected_all_but_private_notes_exist",
                request_id=ctx.request_id, private_hits=scope.private_hits,
            )
        else:
            update["corpus_insufficient"] = _fallback_enabled(state, ctx)
    combined_appends = list(new_commentaries) + list(fresh_chunks)
    if combined_appends:
        # `tool_results` state field uses an append-reducer so returning
        # a list here gets concatenated onto what research_worker wrote.
        update["tool_results"] = combined_appends
    return update

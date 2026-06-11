"""Shared helpers for the worker nodes (research / catalog / action / help).

Every worker is a thin LangGraph adapter that:
  1. Looks up its toolset on `runtime.context` (different attr per worker).
  2. Emits a `status` event so the StatusPill on mobile reflects which
     phase of the turn is running.
  3. Builds the OpenAI-shape tool_schemas from the bound tools.
  4. Optionally renders an "anchor block" header that surfaces the
     UserContext details (focus_ref, current_track_ref, now, history
     summary) the inner LLM needs to pick context-aware tools.
  5. Calls the generic `run_react_loop` ReAct loop with the right
     tools + prompt + tool-event callback.

The use-case (`application/react_loop.py`) is purposely generic — the
"research" in the name is historical. It's the ReAct loop the worker
runs; toolset is parameterised.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Iterable

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.prompts import build_prompt
from shruti_chat.agent.turn_aliases import ChapterRef, ChunkRef, MediaRef, VerseRef
from shruti_chat.application.react_loop import (
    DEFAULT_MAX_TURNS,
    ResearchResult,
    run_react_loop,
)
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.config import get_settings
from shruti_chat.indexer.library.repo import fetch_media, fetch_verse_body
from shruti_chat.observability.langfuse_client import langfuse_node_callback
from shruti_chat.observability.logging import bind_node_role, get_logger


log = get_logger(__name__)


# Worker prompt sections — every tool-calling worker uses the same
# subset. The "voice" sections (citations, response_shape, language,
# safety, followups) shape the FINAL prose — only the synthesizer
# writes that, so they're omitted here. `actions` carries the
# `[action:kind|id=…]` marker protocol — action_worker NEEDS it; the
# others tolerate it (~100 lines is the cost of keeping the worker
# prompt uniform).
WORKER_PROMPT_SECTIONS = ("header", "tools", "actions", "quoting")


def tool_schemas_from(tools: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull OpenAI-format schemas from the registered ToolDefs for the
    subset of tools this worker actually has bound."""
    from shruti_chat.agent.tools._registry import all_tools

    defs = all_tools()
    out: list[dict[str, Any]] = []
    for name in tools:
        td = defs.get(name)
        if td is None:
            log.warning("worker_tool_no_schema", tool=name)
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": td.name,
                    "description": td.description,
                    "parameters": td.parameters,
                },
            }
        )
    return out


def anchor_block(state: ChatState) -> str:
    """Render USER CONTEXT ANCHORS — the bits chat_turn.py wrapper
    extracted from UserContext. Without them the LLM can't know to
    call chunks_get_window (needs a track_ref), can't compute date
    windows for user_tracks_list (needs `now`), and won't realise
    `user_history_search` has anything to search.

    Empty string when no anchors are present — keeps the prompt
    small for trivial turns.
    """
    focus_ref = state.get("focus_ref")
    focus_around_ms = state.get("focus_around_ms")
    current_track_ref = state.get("current_track_ref")
    now_iso = state.get("now_iso")
    history_summary = state.get("history_summary")
    if (
        focus_ref is None
        and current_track_ref is None
        and now_iso is None
        and not history_summary
    ):
        return ""
    lines = ["\n\nUSER CONTEXT ANCHORS"]
    if now_iso is not None:
        lines.append(
            f"- now={now_iso} — the device's current time. Use it to "
            f"compute `since` / `until` ISO-8601 bounds when the user "
            f"asks «вчера / на этой неделе / a week ago»."
        )
    if history_summary is not None:
        lines.append(
            f"- listening_history: {history_summary}. The user HAS listened "
            f"to lectures.\n"
            f"  * \"что я недавно слушал про X\" / \"I heard about X "
            f"recently\" → `user_history_search(query=\"X\")` — REQUIRED: "
            f"pass `query` extracted from the user's phrasing (the topic "
            f"after \"про\" / \"about\"). E.g. user says «что я слушал про "
            f"карму» → query=\"карма\".\n"
            f"  * \"что я слушал на этой неделе\" / \"вчера\" / \"за месяц\" → "
            f"`user_tracks_list(since=\"<iso>\", until=\"<iso>\")` — compute "
            f"both bounds from `now` above.\n"
            f"  * \"что мне послушать дальше\" / \"recommend more\" → "
            f"`user_recommendations_get()` — no args.\n"
            f"  NEVER use `chunks_search` for these — it ignores the user's "
            f"history."
        )
    if current_track_ref is not None:
        lines.append(
            f"- current_track_ref={current_track_ref} — the lecture the user "
            f"is currently listening to. Pass this as `track_ref` when the "
            f"query is about \"this lecture\" / \"эта лекция\"."
        )
    if focus_ref is not None and focus_around_ms is not None:
        lines.append(
            f"- focus_ref={focus_ref}, around_ms={focus_around_ms} — the "
            f"user just tapped this fragment. For \"this fragment\" / "
            f"\"расскажи подробнее\" / \"что было до этого\" → call "
            f"`chunks_get_window(track_ref={focus_ref}, around_ms="
            f"{focus_around_ms})`. For \"найди похожее на этот фрагмент\" → "
            f"`chunks_find_similar(track_ref={focus_ref})`."
        )
    return "\n".join(lines) + "\n"


async def localize_citation(
    ctx: TurnContext,
    *,
    variants: dict[str, str],
    source_text: str,
    src_lang: str | None,
) -> tuple[str, str | None, bool]:
    """Resolve the citation text to SHOW in the turn's answer language.

    Three branches (additive, backward-compatible defaults):
      1. NATIVE — `variants` already has `ctx.lang`: show it, no MT.
         → (native_text, None, mt=False)
      2. TRANSLATE — opted in (`ctx.translate_citations`) and a translator
         is present: machine-translate `source_text` into `ctx.lang`.
         → (translated, source_text, mt=True)
      3. EN-PREFERRED — otherwise: English variant, else the source.
         → (variants["en"] or source_text, None, mt=False)

    `variants` maps lang→text (e.g. verse `translation`); `source_text` is
    the best available original (a non-empty string). Never raises — on a
    translator failure the service itself falls back to the source text.
    """
    native = variants.get(ctx.lang)
    if native:
        return native, None, False
    if ctx.translate_citations and ctx.translator is not None and source_text:
        try:
            translated = await ctx.translator.translate(
                source_text,
                src_lang=src_lang or "en",
                tgt_lang=ctx.lang,
            )
        except Exception as exc:  # noqa: BLE001 — citation never fails the turn
            log.warning(
                "citation_translate_failed",
                request_id=ctx.request_id,
                error=str(exc),
            )
            translated = source_text
        # Only mark as MT when the text actually changed — a same-language
        # no-op (translator returns the source) shouldn't show the badge.
        if translated and translated != source_text:
            return translated, source_text, True
        return source_text, None, False
    return variants.get("en") or source_text, None, False


async def flush_verse_payloads(ctx: TurnContext) -> None:
    """Emit `action.kind=verse` events for every verse alias minted
    on this turn that hasn't been emitted yet — ordering invariant
    from plan section 11.5.1 (payload arrives BEFORE the inline
    `[^N]` marker in delta text).

    Called at the end of any worker that may have minted verse refs
    (research_worker calls chunks_search / chunks_get_by_address →
    minting). Catalog / action / help workers don't, but it's cheap
    to call anyway — the loop short-circuits on empty alias map.
    """
    if ctx.aliases is None or ctx.library_db_path is None:
        return
    writer = get_stream_writer()
    for ref_num, vref in ctx.aliases.verse_refs():
        if ref_num in ctx.emitted_verse_refs:
            continue
        ctx.emitted_verse_refs.add(ref_num)
        if not isinstance(vref, VerseRef):
            continue
        try:
            body = await fetch_verse_body(
                ctx.library_db_path, vref.source_id, vref.tokens
            )
        except Exception as exc:
            log.warning(
                "verse_payload_fetch_failed",
                request_id=ctx.request_id,
                source_id=vref.source_id,
                tokens=vref.tokens,
                error=str(exc),
            )
            continue
        if body is None:
            continue
        # `transliteration` is a per-locale map ({en: IAST, ru: Cyrillic});
        # the wire field stays a single localised string. Pick the turn's
        # lang, fall back to en (clean IAST) so a non-ru locale or a row
        # with only IAST still renders.
        tr = body["transliteration"]
        transliteration = tr.get(ctx.lang) or tr.get("en") or ""
        translation = dict(body["translation"])
        payload: dict[str, Any] = {
            "source_id": vref.source_id,
            "tokens": vref.tokens,
            "addr_label": vref.addr_label or "",
            "sanskrit": body["sanskrit"],
            "transliteration": transliteration,
            "translation": translation,
        }
        # Verse PROSE translation localisation. The transliteration above is
        # a deterministic script conversion (never MT); the `translation` map
        # is natural-language prose. When the turn's lang has no native
        # variant and MT is on, add a translated entry under `ctx.lang` and
        # record the original lang. `translation` stays a multilingual map
        # (the client reads `translation.en` as the original), so no separate
        # `text_original` is needed — only the `mt` flag.
        if ctx.lang not in translation:
            # Pick a non-empty source variant (en-preferred) to translate.
            orig_lang = "en" if translation.get("en") else next(
                (lng for lng, t in translation.items() if t), None
            )
            source = translation.get(orig_lang or "", "")
            shown, _orig, mt = await localize_citation(
                ctx, variants=translation, source_text=source, src_lang=orig_lang,
            )
            if mt:
                translation[ctx.lang] = shown
                payload["mt"] = True
                payload["translation_original_lang"] = orig_lang
        # Expand the stored relative S3 key into a full public URL so the
        # client gets a ready-to-play link (same pattern as track PDFs).
        # Omitted entirely when the verse has no recitation.
        if body["audio_path"]:
            payload["audio_url"] = (
                f"{get_settings().s3_public_url}/{body['audio_path']}"
            )
        writer(
            {
                "type": "action",
                "data": {
                    "kind": "verse",
                    "id": f"verse_{vref.source_id}_{vref.tokens}",
                    "payload": payload,
                },
            }
        )


async def flush_chapter_payloads(ctx: TurnContext) -> None:
    """Emit `action.kind=chapter` events for every chapter-location alias
    minted this turn that hasn't been emitted yet. Mirrors
    `flush_verse_payloads`: the payload MUST arrive BEFORE the
    `[chapter:source/region|label]` marker in the delta so `ChapterCard.vue`
    renders the chapter list (titles verbatim from `library_titles`) rather
    than a bare chip. Titles already ride on the alias — no DB re-read.
    """
    if ctx.aliases is None:
        return
    writer = get_stream_writer()
    for ref_num, cref in ctx.aliases.chapter_refs():
        if ref_num in ctx.emitted_chapter_refs:
            continue
        ctx.emitted_chapter_refs.add(ref_num)
        if not isinstance(cref, ChapterRef):
            continue
        # Chapter titles are already resolved en-preferred (fetch_titles does
        # a lang→en→any fallback), so the default behaviour needs no change.
        # When MT is opted in, translate each title into the answer language
        # and carry the original on `title_original` per chapter. The
        # translator's same-language guard + cache make a no-op (title already
        # in ctx.lang) cheap and mt-free.
        chapters_out: list[dict[str, Any]] = []
        chapter_mt = False
        for tok, title in cref.chapters:
            entry: dict[str, Any] = {"tokens": tok, "title": title}
            if title and ctx.translate_citations and ctx.translator is not None:
                shown, original, mt = await localize_citation(
                    ctx, variants={}, source_text=title, src_lang=None,
                )
                if mt:
                    entry["title"] = shown
                    entry["title_original"] = original
                    chapter_mt = True
            chapters_out.append(entry)
        payload: dict[str, Any] = {
            "source_id": cref.source_id,
            "region_token": cref.region_token,
            "region_label": cref.region_label,
            "chapters": chapters_out,
        }
        if chapter_mt:
            payload["mt"] = True
        writer(
            {
                "type": "action",
                "data": {
                    "kind": "chapter",
                    "id": f"chapter_{cref.source_id}_{cref.region_token}",
                    "payload": payload,
                },
            }
        )


async def flush_media_payloads(ctx: TurnContext) -> None:
    """Emit `action.kind=media` events for every media-clip alias minted
    this turn that hasn't been emitted yet. Mirrors `flush_verse_payloads`:
    the payload MUST arrive BEFORE the `[media:<id>|caption]` marker in the
    delta so the client renders the playable clip card (player + text)
    rather than a bare chip.

    Media chunks are reference-only — the alias carries just the
    `library_media` id, so the playable handle (url / type / speaker) is
    resolved HERE at turn time via fetch_media(item_id), exactly like a
    verse resolves its body via fetch_verse_body.

    Payload shape (relative `url` path — the client resolves it against the
    media CDN base, same contract as track/verse audio):
      {id, url, type, title, speaker?, text}
    """
    if ctx.aliases is None or ctx.library_db_path is None:
        return
    writer = get_stream_writer()
    for ref_num, mref in ctx.aliases.media_refs():
        if ref_num in ctx.emitted_media_refs:
            continue
        ctx.emitted_media_refs.add(ref_num)
        if not isinstance(mref, MediaRef):
            continue
        try:
            row = await fetch_media(ctx.library_db_path, mref.item_id)
        except Exception as exc:
            log.warning(
                "media_payload_fetch_failed",
                request_id=ctx.request_id,
                item_id=mref.item_id,
                error=str(exc),
            )
            continue
        if row is None:
            continue
        payload: dict[str, Any] = {
            "id": mref.item_id,
            "url": row["url"],
            "type": row["type"],
            "title": mref.label,
            "text": mref.text,
        }
        # Media-clip text localisation. Native when the clip's language is
        # the answer language; otherwise translate-if-opted-in (with the
        # original on `text_original`), else show the source verbatim.
        media_lang = mref.lang or row.get("lang") or None
        if mref.text and media_lang and media_lang != ctx.lang:
            shown, original, mt = await localize_citation(
                ctx, variants={media_lang: mref.text},
                source_text=mref.text, src_lang=media_lang,
            )
            if mt:
                payload["text"] = shown
                payload["text_original"] = original
                payload["mt"] = True
        speaker = (row["meta"] or {}).get("speaker")
        if speaker:
            payload["speaker"] = speaker
        writer(
            {
                "type": "action",
                "data": {
                    "kind": "media",
                    "id": f"media_{mref.item_id}",
                    "payload": payload,
                },
            }
        )


async def _fetch_cite_text(ctx: TurnContext, cref: ChunkRef) -> str:
    """Re-fetch a cited fragment's transcript text from the chunk repo
    when it wasn't stashed in `chunk_texts` at mint time. Reached only for
    refs minted outside `lecture_to_envelope` — the pre-minted focus
    fragment and history-restored refs. Returns "" on any miss (no repo,
    no timestamps, no exact row, DB error) so the caller degrades to the
    chip rather than failing the SSE stream.

    Uses an EXACT (track_id, start_ms, end_ms) lookup, NOT an overlap
    query: transcript chunks overlap by design (indexer/chunker.py), so an
    overlap fetch would join neighbouring chunks and return text spanning a
    far wider range than the cited [start_ms, end_ms] window. History refs
    carry real chunk bounds and resolve exactly; a focus span the user
    tapped may not be a chunk boundary, in which case the exact lookup
    misses and the card falls back to the chip — better than over-broad
    text that doesn't match the audio. `cref.lang` (captured at mint /
    round-tripped through history) pins the transcript language.
    """
    repo = ctx.chunk_repo
    if repo is None or cref.start_ms is None or cref.end_ms is None:
        return ""
    try:
        text = await repo.get_chunk_text_exact(
            cref.track_id,
            start_ms=cref.start_ms,
            end_ms=cref.end_ms,
            lang=cref.lang,
        )
    except Exception as exc:
        log.warning(
            "cite_payload_fetch_failed",
            request_id=ctx.request_id,
            track_id=cref.track_id,
            start_ms=cref.start_ms,
            end_ms=cref.end_ms,
            error=str(exc),
        )
        return ""
    return text.strip() if isinstance(text, str) else ""


async def flush_cite_payloads(ctx: TurnContext) -> None:
    """Emit `action.kind=cite_transcript` events for every cite-able
    lecture fragment whose transcript text is known and hasn't been
    emitted yet. Mirrors `flush_verse_payloads`: the payload MUST arrive
    BEFORE the `[cite:track@s-e|caption]` marker in the delta text, so
    `CitationCard.vue` can render the full quote block (player + text +
    attributes) instead of the small chip fallback.

    Text comes from `aliases.chunk_texts`, filled by the research
    pipeline over the same cite-able set the caption pass uses. A fragment
    aliased OUTSIDE that pass — by a catalog/action/help ReAct worker, the
    pre-minted focus fragment, or round-tripped from a prior turn — has no
    stashed text, so the snippet is re-fetched on demand from the chunk
    repo (mirroring how `flush_verse_payloads` re-reads verse bodies).
    Only a genuine miss (no repo / DB error / fragment gone) degrades to
    the chip.
    """
    if ctx.aliases is None:
        return
    writer = get_stream_writer()
    for ref_num, cref in ctx.aliases.cite_refs():
        if ref_num in ctx.emitted_cite_refs:
            continue
        text = ctx.aliases.chunk_texts.get(ref_num)
        if not text:
            text = await _fetch_cite_text(ctx, cref)
        if not text:
            continue
        ctx.emitted_cite_refs.add(ref_num)
        payload: dict[str, Any] = {
            "track_id": cref.track_id,
            "start_ms": cref.start_ms,
            "end_ms": cref.end_ms,
            "text": text,
        }
        # Transcript localisation. A fragment is "native" when its language
        # matches the answer language; otherwise translate-if-opted-in,
        # else show the (English / source) transcript verbatim. There is no
        # per-lang transcript map — the only original is `text` in `cref.lang`.
        if cref.lang and cref.lang != ctx.lang:
            shown, original, mt = await localize_citation(
                ctx, variants={cref.lang: text}, source_text=text, src_lang=cref.lang,
            )
            if mt:
                payload["text"] = shown
                payload["text_original"] = original
                payload["mt"] = True
        writer(
            {
                "type": "action",
                "data": {
                    "kind": "cite_transcript",
                    "id": f"cite_{cref.track_id}_{cref.start_ms}_{cref.end_ms}",
                    "payload": payload,
                },
            }
        )


async def translate_commentaries(ctx: TurnContext) -> None:
    """Pre-translate inline-commentary purport sentences before the
    synthesizer streams `[^N|s=…]` markers.

    `marker_expander._format_commentary` runs synchronously inside the
    delta stream and has no ctx / translator handle, so the translation
    must be ready on the alias BEFORE streaming. We translate each
    commentary's sentences concurrently in the worker and stash the result
    on the ref via `set_commentary_translation`; the expander then renders
    `sentences_translated or sentences`. No-op unless MT is opted in.
    """
    if (
        ctx.aliases is None
        or not ctx.translate_citations
        or ctx.translator is None
    ):
        return

    async def _one(n: int, sentences: tuple[str, ...]) -> None:
        if not sentences:
            return
        # Translate the joined block once (preserves sentence boundaries far
        # better than per-sentence calls) then re-split on the same count.
        joined = "\n".join(sentences)
        try:
            translated = await ctx.translator.translate(
                joined, src_lang="en", tgt_lang=ctx.lang,
            )
        except Exception as exc:  # noqa: BLE001 — citation never fails the turn
            log.warning(
                "commentary_translate_failed",
                request_id=ctx.request_id, ref=n, error=str(exc),
            )
            return
        if not translated or translated == joined:
            return
        parts = translated.split("\n")
        # Keep index alignment with `sentences` so `[^N|s=…]` picks resolve.
        # If the model collapsed/added newlines, fall back to the source
        # rather than mis-aligning sentence indices.
        if len(parts) != len(sentences):
            return
        ctx.aliases.set_commentary_translation(
            n, sentences_translated=tuple(parts), mt=True,
        )

    targets = ctx.aliases.commentary_refs()
    if not targets:
        return
    await asyncio.gather(*(_one(n, ref.sentences) for n, ref in targets))


async def run_worker(
    state: ChatState,
    runtime: Runtime[TurnContext],
    *,
    role: str,
    tools: dict[str, Any],
    status_key: str,
    include_anchors: bool = True,
    max_turns: int = DEFAULT_MAX_TURNS,
    extra_user_query: str | None = None,
) -> ResearchResult:
    """Generic worker body: status → ReAct loop → flush verses.

    Returns the raw `ResearchResult` so the caller can decide what
    to put in state["tool_results"] (research/catalog/help append;
    action_worker may merge with prior research results).

    `extra_user_query` overrides `state["user_query"]` when set — used
    by action_worker which runs AFTER research and wants to ask
    "now compose the action from the tracks above" instead of repeating
    the original user prompt.
    """
    bind_node_role(role)
    ctx = runtime.context

    prompt_prefix = anchor_block(state) if include_anchors else ""
    system_prompt = prompt_prefix + build_prompt(WORKER_PROMPT_SECTIONS, lang=state["lang"])
    schemas = tool_schemas_from(tools)

    writer = get_stream_writer()

    def _on_tool_event(event: str, tool_name: str) -> None:
        if event == "tool_start":
            writer({"type": "tool_start", "data": {"name": tool_name}})
        else:
            writer({"type": "tool_end", "data": {"name": tool_name}})

    def _yield_event(event_type: str, data: dict[str, Any]) -> None:
        """Bridge an emits_events tool's `yield_event(type, data)` call
        into a LangGraph custom-stream write so the SSE transport
        forwards it to the client. Without this hop the action_id the
        LLM gets back is never paired with an SSE `action` event, and
        the matching `[action:share_pdf|id=…]` marker in delta
        text renders as a broken card on mobile.

        Also records the action id of every real `action` event (the
        ones minted by track_pdf_generate / propose_* — they carry a
        hex `id`) so the MarkerExpander can drop any `[action:...|id=X]`
        marker whose id never actually fired. The verse / chapter /
        cite payload events also flow through `writer` but those use a
        synthetic string id (e.g. `verse_BG_2.13`) and aren't action
        markers, so we only capture ids from `propose_*`/pdf — keyed on
        the hex-`id` shape the marker grammar accepts.
        """
        if event_type == "action":
            action_id = data.get("id")
            if isinstance(action_id, str) and action_id:
                ctx.emitted_action_ids.add(action_id)
        writer({"type": event_type, "data": data})

    writer({"type": "status", "data": {"key": status_key}})

    # Build the Langfuse callback ONCE per worker invocation. Inside
    # the ReAct loop each iteration calls `stream_completion` with the
    # SAME callback list — Langfuse aggregates the multi-step LLM
    # interactions under the worker's span. None when observability is
    # disabled; the LLM adapter then skips the `callbacks` kwarg.
    cb = langfuse_node_callback(ctx.langfuse_trace_id, role) if ctx.langfuse_trace_id else None
    callbacks_list = [cb] if cb is not None else None

    result = await run_react_loop(
        extra_user_query or state["user_query"],
        extracted_args=state.get("extracted_args", {}),
        llm=ctx.llm,
        tools=tools,
        tool_schemas=schemas,
        aliases=ctx.aliases,
        system_prompt=system_prompt,
        request_id=ctx.request_id,
        max_turns=max_turns,
        on_tool_event=_on_tool_event,
        yield_event=_yield_event,
        callbacks=callbacks_list,
        run_name=role,
    )

    # Pre-translate inline-commentary purports (if opted in) concurrently
    # with the citation-payload flushes — the translation latency overlaps,
    # and the flush ordering invariant (action emitted BEFORE its marker) is
    # preserved because every flush completes before run_worker returns and
    # the synthesizer streams. Each flush itself may translate verse / cite /
    # media text; running them concurrently overlaps those calls too.
    await asyncio.gather(
        flush_verse_payloads(ctx),
        flush_media_payloads(ctx),
        flush_cite_payloads(ctx),
        translate_commentaries(ctx),
    )
    return result

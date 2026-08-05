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
from dataclasses import dataclass
from typing import Any, Callable

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.prompts import build_prompt, standalone_prompt
from shruti_chat.agent.turn_aliases import ChapterRef, ChunkRef, MediaRef, VerseRef
from shruti_chat.application.react_loop import (
    DEFAULT_MAX_TURNS,
    ResearchResult,
    run_react_loop,
)
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.application.cache_helpers import TTL_30D, cached_llm_json
from shruti_chat.config import get_settings
from shruti_chat.domain.entities import Message
from shruti_chat.indexer.library.repo import fetch_media, fetch_verse_body
from shruti_chat.observability.langfuse_client import langfuse_node_callback
from shruti_chat.research.pipeline import reduce_locale_to_content_lang
from shruti_chat.observability.logging import bind_node_role, get_logger

from pydantic import BaseModel, Field


log = get_logger(__name__)


class LocalizedReply(BaseModel):
    """A short assistant reply generated in the USER's language."""

    line: str
    chips: list[str] = Field(default_factory=list)


# Overrides the prompt's JSON contract on the retry below. Stays in code rather
# than in the `.md`: it exists only because the TRANSPORT changed
# (`text_completion` instead of `structured_output`), and an editor tuning the
# wording in Langfuse must not be able to break a schema contract.
_PLAIN_LINE_RULE = (
    "Ignore the JSON contract above: return ONLY that one line as plain text. "
    "No JSON, no quotes, no chips, no explanation."
)


async def localized_reply(ctx: TurnContext, situation: str) -> LocalizedReply:
    """One cheap-LLM call that writes a short chat reply in the user's language
    (`ctx.lang_code`) from an English `situation` description: a `line` plus 0-3
    tappable follow-up `chips`. This is how the service localizes fixed replies
    to EVERY shipped locale (es/hi/bn/uk/sr/…), not just a hardcoded ru/en pair
    — same pattern as the find_tracks intro. Degrades to an empty reply on any
    LLM miss so a localization failure never crashes the SSE stream.

    KV-cached by `(situation, lang, model)` for 30 days: these replies are
    deterministic for a given situation+language, so the same "no lectures on
    <ref>" or "name a lecture" phrasing is written by the LLM once and then
    served from cache — no per-turn model call on the hot paths."""
    sys = standalone_prompt("localized-reply", "localized_reply")
    usr = f"Language code: {ctx.lang_code}\nSituation: {situation}"
    msgs: list[Message] = [
        {"role": "system", "content": sys},
        {"role": "user", "content": usr},
    ]
    model = get_settings().llm_cheap

    async def _call() -> LocalizedReply:
        try:
            return await ctx.llm.structured_output(
                msgs, LocalizedReply, model=model, run_name="localized_reply",
            )
        except Exception as exc:  # noqa: BLE001
            # A one-line reply plus up to three chips is too small a thing to
            # lose a turn over, and in production both the primary AND the
            # fallback model failed to emit parseable JSON for it — the user got
            # a blank bubble. Ask again with NO JSON envelope, so there is no
            # parse step left to miss (`text_completion` exists for exactly
            # this). Chips are dropped: they are a nicety, the line is not.
            log.warning(
                "localized_reply_json_missed",
                request_id=ctx.request_id, error=str(exc),
            )
            line = await ctx.llm.text_completion(
                [
                    {"role": "system", "content": f"{sys}\n\n{_PLAIN_LINE_RULE}"},
                    {"role": "user", "content": usr},
                ],
                model=model,
                run_name="localized_reply_plain",
            )
            return LocalizedReply(line=line.strip(), chips=[])

    try:
        if ctx.kv_cache is not None:
            return await cached_llm_json(
                ctx.kv_cache, ns="localized_reply",
                key_parts={"s": situation, "lang": ctx.lang_code, "model": model},
                ttl_s=TTL_30D, schema=LocalizedReply, factory=_call,
            )
        return await _call()
    except Exception:  # noqa: BLE001 — never fail the turn on a phrasing miss
        log.exception("localized_reply_failed", request_id=ctx.request_id)
        return LocalizedReply(line="", chips=[])


# Worker prompt sections — every tool-calling worker uses the same
# subset. The "voice" sections (citations, response_shape, language,
# safety, followups) shape the FINAL prose — only the synthesizer
# writes that, so they're omitted here. `actions` carries the
# `[action:kind|id=…]` marker protocol — action_worker NEEDS it; the
# others tolerate it (~100 lines is the cost of keeping the worker
# prompt uniform).
WORKER_PROMPT_SECTIONS = ("header", "tools", "actions", "quoting")


async def owned_track_ids(ctx: TurnContext) -> list[str] | None:
    """The tracks THIS user added, for the private lecture lane (#1227).

    Resolved server-side from the verified JWT `sub` — NEVER from client-supplied
    recent_tracks. Best-effort: a failed lookup degrades to public-corpus-only
    rather than failing the turn.

    Shared because two lanes retrieve lectures and only one of them remembered
    to ask: the out-of-corpus fallback searched without this (and without the
    author scope), so a personal library was invisible in exactly the turn that
    announced the corpus had nothing.
    """
    if not ctx.user_id or ctx.chunk_repo is None:
        return None
    try:
        return await ctx.chunk_repo.get_owned_track_ids(ctx.user_id)
    except Exception as exc:  # noqa: BLE001 — private lane is best-effort
        log.warning("owned_track_ids_lookup_failed", error=str(exc))
        return None


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
    force: bool = False,
) -> tuple[str, str | None, bool]:
    """Resolve the citation text to SHOW in the turn's answer language.

    Three branches (additive, backward-compatible defaults):
      1. NATIVE — `variants` already has `ctx.lang_code`: show it, no MT.
         → (native_text, None, mt=False)
      2. TRANSLATE — a translator is present and either the caller `force`s it or
         the turn opted in (`ctx.translate_citations`): machine-translate
         `source_text` into `ctx.lang_code`. → (translated, source_text, mt=True)
      3. EN-PREFERRED — otherwise: English variant, else the source.
         → (variants["en"] or source_text, None, mt=False)

    `variants` maps lang→text (e.g. verse `translation`); `source_text` is
    the best available original (a non-empty string). Never raises — on a
    translator failure the service itself falls back to the source text.
    """
    native = variants.get(ctx.lang_code)
    if native:
        return native, None, False
    if (force or ctx.translate_citations) and ctx.translator is not None and source_text:
        try:
            translated = await ctx.translator.translate(
                source_text,
                src_lang=src_lang or "en",
                tgt_lang=ctx.lang_code,
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


def _verse_display_lang(lang: str, translation: dict[str, str]) -> str:
    """Which language the verse card shows: the answer language when the verse
    has it (native or MT-filled), else en, else whatever exists. Always names a
    language the payload actually carries."""
    if translation.get(lang):
        return lang
    if translation.get("en"):
        return "en"
    return next((lng for lng, text in translation.items() if text), lang)


def _verse_translation_wire(
    shown_lang: str, translation: dict[str, str], *, mt: bool,
) -> dict[str, str]:
    """The lang→text map the card needs: the shown translation, plus `en` when
    the shown one is a machine translation (the card's "view original" toggle
    flips to it). A single entry also keeps a client that ignores `lang` right:
    its `map[locale] → map.en → first entry` fallback has one text to find."""
    wire = {shown_lang: translation.get(shown_lang, "")}
    if mt and shown_lang != "en" and translation.get("en"):
        wire["en"] = translation["en"]
    return wire


async def build_verse_payload(ctx: TurnContext, vref: VerseRef) -> dict[str, Any] | None:
    """Fetch + build ONE verse card payload (sanskrit / transliteration /
    translation / audio). For a non-corpus answer with translation opted in,
    the prose `translation` map gains a translated `ctx.lang_code` entry (+ mt);
    native (ru/en) answers translate nothing. Returns None on fetch failure
    or missing body.

    Shared by the eager `flush_card_payloads` (legacy clients) and
    the lazy synth-time emit (`synthesizer._emit_verse_card`): the DB fetch
    is cheap and identical, but card clients call this only for the verses
    actually CITED, so the (expensive) translation never runs on the rest of
    the pool.
    """
    if ctx.library_db_path is None:
        return None
    try:
        body = await fetch_verse_body(ctx.library_db_path, vref.source_id, vref.tokens)
    except Exception as exc:
        log.warning(
            "verse_payload_fetch_failed",
            request_id=ctx.request_id,
            source_id=vref.source_id,
            tokens=vref.tokens,
            error=str(exc),
        )
        return None
    if body is None:
        return None
    # `transliteration` is a per-locale map ({en: IAST, ru: Cyrillic}); the
    # wire field stays a single localised string. Pick the turn's lang, fall
    # back to en (clean IAST) so a non-ru locale / IAST-only row still renders.
    tr = body["transliteration"]
    transliteration = tr.get(ctx.lang_code) or tr.get("en") or ""
    transliteration_iast = tr.get("en") or ""
    translation = dict(body["translation"])
    payload: dict[str, Any] = {
        "source_id": vref.source_id,
        "tokens": vref.tokens,
        "addr_label": vref.addr_label or "",
        "sanskrit": body["sanskrit"],
        "transliteration": transliteration,
    }
    # Original IAST (Latin) transliteration, shipped only when the localised
    # script differs from it — lets the client's "view original" toggle flip
    # the transliteration together with the translation.
    if transliteration_iast and transliteration_iast != transliteration:
        payload["transliteration_original"] = transliteration_iast
    # Verse PROSE translation. The transliteration above is deterministic
    # (never MT); the `translation` map is natural-language prose. When the
    # turn's lang has no native variant and MT is on, add a translated entry
    # under `ctx.lang_code` + record the original lang.
    if ctx.lang_code not in translation:
        orig_lang = "en" if translation.get("en") else next(
            (lng for lng, t in translation.items() if t), None
        )
        source = translation.get(orig_lang or "", "")
        shown, _orig, mt = await localize_citation(
            ctx, variants=translation, source_text=source, src_lang=orig_lang,
        )
        if mt:
            translation[ctx.lang_code] = shown
            payload["mt"] = True
            payload["translation_original_lang"] = orig_lang
    # `ctx.lang_code` is the answer language (the router settles it before any card
    # is built), so the shown translation is picked here rather than by the
    # client's UI locale. `lang` names what `translation` carries.
    shown_lang = _verse_display_lang(ctx.lang_code, translation)
    payload["lang"] = shown_lang
    payload["translation"] = _verse_translation_wire(
        shown_lang, translation, mt=bool(payload.get("mt")),
    )
    # Expand the stored relative key into a full public URL on the media CDN
    # (Bunny). Omitted entirely when the verse has no recitation.
    if body["audio_path"]:
        base = get_settings().media_base_url.rstrip("/")
        payload["audio_url"] = f"{base}/{body['audio_path']}"
    return payload


async def build_chapter_payload(ctx: TurnContext, cref: ChapterRef) -> dict[str, Any] | None:
    """Build ONE chapter-location card payload (the canto/chapter list). When
    MT is opted in, each title is translated into the answer language with the
    original on `title_original` (the translator's same-language guard + cache
    make a native no-op free). Titles ride on the alias — no DB read."""
    if not isinstance(cref, ChapterRef):
        return None
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
    return payload


async def build_media_payload(ctx: TurnContext, mref: MediaRef) -> dict[str, Any] | None:
    """Build ONE media-clip card payload. The alias carries only the
    `library_media` id, so the playable handle (url / type / speaker) is
    resolved here via `fetch_media`. The transcript `text` is translated for
    a non-corpus answer (with the original on `text_original`). Returns None
    on fetch failure / missing row (marker degrades to the chip)."""
    if not isinstance(mref, MediaRef) or ctx.library_db_path is None:
        return None
    try:
        row = await fetch_media(ctx.library_db_path, mref.item_id)
    except Exception as exc:
        log.warning(
            "media_payload_fetch_failed",
            request_id=ctx.request_id, item_id=mref.item_id, error=str(exc),
        )
        return None
    if row is None:
        return None
    payload: dict[str, Any] = {
        "id": mref.item_id,
        "url": row["url"],
        "type": row["type"],
        "title": mref.label,
        "text": mref.text,
    }
    media_lang = mref.lang or row.get("lang") or None
    if mref.text and media_lang and media_lang != ctx.lang_code:
        shown, original, mt = await localize_citation(
            ctx, variants={media_lang: mref.text},
            source_text=mref.text, src_lang=media_lang,
        )
        if mt:
            payload["text"] = shown
            payload["text_original"] = original
            payload["mt"] = True
    meta = row["meta"] or {}
    speaker = meta.get("speaker")
    if speaker:
        payload["speaker"] = speaker
    media_date = meta.get("date")
    if media_date:
        payload["date"] = media_date
    return payload


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


def _format_reference_label(ref: Any) -> str:
    """Render one catalog reference as the client shows it — "{short} {tokens}"
    (e.g. "ŚB 1.2.3"), falling back to the source id when the localized short
    name is absent. The thin client renders this verbatim, never touching a
    sources dictionary."""
    short = ref.short_name or ref.source_id
    tokens = (ref.tokens or "").strip()
    return f"{short} {tokens}".strip() if tokens else short


async def resolve_track_display(ctx: TurnContext, track_id: str) -> dict[str, Any]:
    """Resolve a track's display attribution (title / author / date /
    references) localized to the answer language, for clients that hold no
    local catalog (web). Cached per-turn by `(track_id, lang)` so several
    cites of one lecture cost a single catalog read. Returns {} on any miss
    (no repo, unknown track, DB error) so the card still renders without a
    header — never raises into the SSE stream.

    The catalog dictionaries (source/author/location/tag names) exist only in
    corpus content languages (en, ru), so we resolve in the collapsed content
    language (`uk`→`ru`, `sr`→`en`) rather than the raw answer locale. Without
    it a Ukrainian turn finds no `uk` rows and renders the raw catalog ids
    (`source_dsicuBsFvinZ 2.19`, raw `tag_id`s) verbatim — the mobile client
    sidesteps this by resolving from its on-device dictionary, but the web
    client trusts these server labels."""
    if ctx.catalog_repo is None:
        return {}
    display_lang = reduce_locale_to_content_lang(ctx.lang_code)
    key = (track_id, display_lang)
    cached = ctx.track_display_cache.get(key)
    if cached is not None:
        return cached
    out: dict[str, Any] = {}
    try:
        track = await ctx.catalog_repo.get_track(track_id, lang=display_lang)
    except Exception as exc:
        log.warning(
            "track_display_resolve_failed",
            request_id=ctx.request_id, track_id=track_id, error=str(exc),
        )
        track = None
    if track is not None:
        if track.title:
            out["track_title"] = track.title
        if track.author_name:
            out["author_name"] = track.author_name
        if track.date:
            out["date"] = track.date
        refs = [
            {
                "source_id": r.source_id,
                "tokens": r.tokens,
                "label": _format_reference_label(r),
            }
            for r in track.references
        ]
        if refs:
            out["references"] = refs
    ctx.track_display_cache[key] = out
    return out


async def build_cite_payload(ctx: TurnContext, ref_num: int, cref: Any) -> dict[str, Any] | None:
    """Build ONE lecture-transcript cite payload: resolve the snippet text
    (stashed by the research caption pass, else re-fetched) and, for a
    non-corpus answer with translation opted in, translate it. Returns None
    when no text is available (the marker degrades to the chip).

    Shared by the eager `flush_card_payloads` (legacy clients) and the lazy
    synth-time emit (card clients) — the latter calls this only for the
    fragments actually CITED, so the translation runs on a handful instead
    of the whole research pool, and overlaps generation via the bridge."""
    if ctx.aliases is None:
        return None
    text = ctx.aliases.chunk_texts.get(ref_num)
    if not text:
        text = await _fetch_cite_text(ctx, cref)
    if not text:
        return None
    payload: dict[str, Any] = {
        "track_id": cref.track_id,
        "start_ms": cref.start_ms,
        "end_ms": cref.end_ms,
        "text": text,
    }
    # Display attribution (title / author / date / references) so a client
    # with no local catalog (web) can render the card header. Mobile keeps
    # resolving it from its on-device DB and ignores these fields.
    payload.update(await resolve_track_display(ctx, cref.track_id))
    # Transcript localisation. A fragment is "native" when its language matches
    # the answer language; otherwise it is TRANSLATED — without waiting to be
    # asked, unlike a verse or a purport. The opt-in exists to protect the
    # wording of scripture, and spoken words are not scripture: showing an
    # English transcript to someone reading Russian is not fidelity, it is a
    # quote they cannot read. Someone's OWN uploads are usually in another
    # language than their question, so this is the difference between a usable
    # answer and a wall of English. The original rides along (`text_original`,
    # `mt`) so a client can offer it.
    if cref.lang and cref.lang != ctx.lang_code:
        shown, original, mt = await localize_citation(
            ctx, variants={cref.lang: text}, source_text=text, src_lang=cref.lang,
            force=True,
        )
        if mt:
            payload["text"] = shown
            payload["text_original"] = original
            payload["mt"] = True
    return payload


@dataclass(frozen=True)
class CardSpec:
    """One auto-render card kind (verse / cite / media / chapter).

    The eager flush AND the lazy synth-time emit both drive this single
    registry, and the (translation-bearing) `build` is the ONLY place a
    payload is produced. So a new card kind is wired everywhere by adding
    ONE entry here — there is no separate per-kind eager-gate or translate
    step left to forget. See `flush_card_payloads` (eager) and
    `synthesizer._bridge_synth_events` (lazy), both of which iterate this.
    """

    family: str                                     # marker family the expander queues
    action_kind: str                                # SSE `action.kind`
    refs: Callable[[Any], list[tuple[int, Any]]]    # aliases -> [(ref_num, ref)]
    build: Callable[[TurnContext, int, Any], Any]   # (ctx, ref_num, ref) -> awaitable[payload|None]
    card_id: Callable[[Any], str]                   # ref -> action id
    dedup_key: Callable[[Any], tuple]               # ref -> once-per-turn dedup key


CARD_SPECS: tuple[CardSpec, ...] = (
    CardSpec(
        "verse", "verse",
        lambda a: a.verse_refs(),
        lambda ctx, n, r: build_verse_payload(ctx, r),
        lambda r: f"verse_{r.source_id}_{r.tokens}",
        lambda r: (r.source_id, r.tokens),
    ),
    CardSpec(
        "cite", "cite_transcript",
        lambda a: a.cite_refs(),
        build_cite_payload,
        lambda r: f"cite_{r.track_id}_{r.start_ms}_{r.end_ms}",
        lambda r: (r.track_id, r.start_ms, r.end_ms),
    ),
    CardSpec(
        "media", "media",
        lambda a: a.media_refs(),
        lambda ctx, n, r: build_media_payload(ctx, r),
        lambda r: f"media_{r.item_id}",
        lambda r: (r.item_id,),
    ),
    CardSpec(
        "chapter", "chapter",
        lambda a: a.chapter_refs(),
        lambda ctx, n, r: build_chapter_payload(ctx, r),
        lambda r: f"chapter_{r.source_id}_{r.region_token}",
        lambda r: (r.source_id, r.region_token),
    ),
)

CARD_SPEC_BY_FAMILY: dict[str, CardSpec] = {s.family: s for s in CARD_SPECS}


async def flush_card_payloads(ctx: TurnContext) -> None:
    """Eager emission of every auto-render card (verse / cite / media /
    chapter) for LEGACY clients. THE single gate: card-capable clients emit
    these lazily (cited-only) at synth time via the synthesizer bridge, so
    this returns immediately for them — no per-kind gate to forget. Iterates
    `CARD_SPECS`, so a new card kind is covered with no change here."""
    if ctx.aliases is None or ctx.capabilities.get("commentary_card"):
        return
    writer = get_stream_writer()
    for spec in CARD_SPECS:
        for ref_num, ref in spec.refs(ctx.aliases):
            key = (spec.family, spec.dedup_key(ref))
            if key in ctx.emitted_card_keys:
                continue
            payload = await spec.build(ctx, ref_num, ref)
            if payload is None:
                continue
            ctx.emitted_card_keys.add(key)
            writer(
                {
                    "type": "action",
                    "data": {
                        "kind": spec.action_kind,
                        "id": spec.card_id(ref),
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

    LEGACY (inline-blockquote) clients only. Card-capable clients translate
    LAZILY in `synthesizer.py` — only the purports actually cited, not the
    whole candidate pool. Pre-translating every attached purport here meant
    translating ~10x more text than the answer ends up showing, so it's
    skipped entirely when the client renders commentary cards.
    """
    if (
        ctx.aliases is None
        or not ctx.translate_citations
        or ctx.translator is None
        or ctx.capabilities.get("commentary_card")
    ):
        return

    async def _tr_one(s: str) -> str:
        """Translate a single sentence; on any failure keep the source so
        index alignment with `sentences` is never broken."""
        if not s.strip():
            return s
        try:
            out = await ctx.translator.translate(
                s, src_lang=ctx.retrieval_lang_code, tgt_lang=ctx.lang_code,
            )
        except Exception:  # noqa: BLE001 — citation never fails the turn
            return s
        return out or s

    async def _one(n: int, sentences: tuple[str, ...]) -> None:
        if not sentences:
            return
        # Prefer ONE joined call (best sentence-boundary context) and
        # re-split. The model often reflows the newlines, though, so when
        # the split count no longer matches we CANNOT trust the alignment —
        # fall back to per-sentence translation (each independently cached)
        # instead of dropping the translation and leaving the purport in its
        # source language (the bug this replaces).
        joined = "\n".join(sentences)
        whole: str | None
        try:
            whole = await ctx.translator.translate(
                joined, src_lang=ctx.retrieval_lang_code, tgt_lang=ctx.lang_code,
            )
        except Exception as exc:  # noqa: BLE001 — citation never fails the turn
            whole = None
            log.warning(
                "commentary_translate_failed",
                request_id=ctx.request_id, ref=n, error=str(exc),
            )
        if whole and whole != joined and len(whole.split("\n")) == len(sentences):
            parts: tuple[str, ...] = tuple(whole.split("\n"))
        else:
            parts = tuple(await asyncio.gather(*(_tr_one(s) for s in sentences)))
        # Nothing actually changed (same-language no-op / all calls failed)
        # → don't flag MT, render the verbatim source.
        if all(a == b for a, b in zip(parts, sentences)):
            return
        ctx.aliases.set_commentary_translation(
            n, sentences_translated=parts, mt=True,
        )

    # Skip refs already translated on an earlier pass — this runs both in
    # research_worker and (for the planner's lazy attaches) in
    # synthesis_planner, so it must be idempotent. `sentences_translated`
    # set ⇒ already handled; None ⇒ never attempted (or a prior failure,
    # safe to retry).
    targets = [
        (n, ref)
        for n, ref in ctx.aliases.commentary_refs()
        if ref.sentences_translated is None
    ]
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
        flush_card_payloads(ctx),
        translate_commentaries(ctx),
    )
    return result

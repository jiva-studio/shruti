"""Card + citation payload rendering.

Everything the client needs to draw a verse card, a chapter card, a media
player or a citation chip, plus the per-turn flush that emits them and the
opt-in translation of quoted commentary.

Extracted from `agent/graph/nodes/_worker_common.py`, which had grown to 889
lines of four unrelated concerns. This was 547 of them, and none of it is
worker-specific — it is simply where the code landed.

The BUILDERS are pure: a `TurnContext` in, a payload dict out, no graph and no
`ChatState`. The flush is not — emitting is inherently a stream concern, so it
reaches for LangGraph's `get_stream_writer`. (The plan claimed the whole block
was graph-free; it is not, and the flush is why.)

`CARD_SPECS` is the registry driving both the eager flush and the lazy
per-card path, so a new card kind is one entry here rather than edits scattered
across the emit sites.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from langgraph.config import get_stream_writer

from shruti_chat.agent.prompts import standalone_prompt
from shruti_chat.agent.turn_aliases import ChapterRef, ChunkRef, MediaRef, VerseRef
from shruti_chat.config import get_settings
from shruti_chat.research.pipeline import reduce_locale_to_content_lang
from shruti_chat.observability.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover
    # Type-only: importing it at runtime closes a cycle, since
    # agent.graph.nodes._worker_common imports this module. Annotations are
    # postponed, so nothing is needed here at run time.
    from shruti_chat.agent.graph.turn_context import TurnContext


log = get_logger(__name__)


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
    if ctx.library_repo is None:
        return None
    try:
        body = await ctx.library_repo.fetch_verse_body(vref.source_id, vref.tokens)
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
    if not isinstance(mref, MediaRef) or ctx.library_repo is None:
        return None
    try:
        row = await ctx.library_repo.fetch_media(mref.item_id)
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


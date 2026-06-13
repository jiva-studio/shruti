"""Show-verse worker — the lightweight path for a bare scripture reference.

Reached when `AddressClassifier` (pre-router) resolved the query to a concrete
verse and set `intent="show_verse"` + `extracted_args={source_id, tokens}`.

No research pipeline: it mints a verse alias, flushes the verse-card payload
(so the client renders the full card — sanskrit / transliteration / translation
in the user's language, MT-fallback handled by `build_verse_payload`), and hands
a single verse note to the synthesizer for a short lead-in + follow-up chips.
Mirrors `locate_worker` (worker → synthesizer, no `synthesis_planner`).
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import flush_card_payloads
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.logging import bind_node_role, get_logger

log = get_logger(__name__)


async def show_verse_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("show_verse_worker")
    ctx = runtime.context
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "composing_answer"}})

    args = state.get("extracted_args") or {}
    source_id = args.get("source_id")
    tokens = args.get("tokens")
    if not source_id or not tokens:
        # Shouldn't happen (the classifier only emits show_verse with both),
        # but degrade to a tool-less synthesizer reply rather than crash.
        log.warning("show_verse_missing_args", request_id=ctx.request_id)
        return {"tool_results": []}

    # Compose a human address ("БГ 2.13") for the card label and the
    # follow-up chips. short_name is per-locale (en fallback) — the chip TEXT
    # around it is localized by the synthesizer, so es/hi/bn users still get
    # "BG 2.13" + their-language prose.
    addr_label = ""
    if ctx.catalog_repo is not None:
        try:
            short = await ctx.catalog_repo.source_short_label(source_id, lang=ctx.lang)
        except Exception:  # noqa: BLE001 — a label miss must never fail the turn
            short = None
        if short:
            addr_label = f"{short} {tokens}"
    ref = ctx.aliases.alias_verse(source_id, tokens, addr_label=addr_label)
    note = {
        "type": "verse",
        "ref": ref,
        "text": addr_label or tokens,
        "meta": {"source_id": source_id, "tokens": tokens},
    }
    # Eager card payload for legacy clients; the lazy synth-time emit covers
    # the rest. Must precede the inline `[^N]` marker in the delta stream.
    await flush_card_payloads(ctx)

    log.info(
        "show_verse_worker_complete",
        request_id=ctx.request_id,
        source_id=source_id,
        tokens=tokens,
    )
    return {"tool_results": [note]}

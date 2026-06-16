"""Action node — DETERMINISTIC. No LLM.

For `create_action` the inputs are fully determined: the router already
classified `action_kind`, and the gather step (catalog/research) or the
user-context anchors already produced the tracks. So the action itself —
calling `track_pdf_generate` / a `propose_*` hint and emitting the SSE
`action` event — is plain code, not a judgement call.

Routing this through an LLM ReAct loop (the previous design) was the
SOURCE of the bug: the worker would call `track_pdf_generate([])` with no
tracks, or invent an `action_id` — producing a confident «Готую PDF» with
no file. Removing the LLM removes that class of failure entirely.

The synthesizer still writes the surrounding prose and emits the
`[action:<kind>|id=…]` marker from the `ACTION CARD READY` note this node
appends to `tool_results` — composing prose is the only part that needs
intelligence. The "smart" gather (which lectures match) stays upstream in
the catalog/research worker.

Track resolution for a PDF, by priority:
  1. the lecture / fragment the user is anchored on (current_track_ref /
     focus_ref),
  2. the tracks the gather step found THIS turn (catalog lecture rows or
     research transcript chunks — both carry an integer `ref` that
     de-aliases to a real track_id; verse / commentary refs carry none and
     are skipped),
  3. the tracks of a PRIOR turn the user points at deictically
     («pdf этих лекций»),
  4. the user's last-played lecture (recent_ref → user_tracks_list).
"""

from __future__ import annotations

from typing import Any

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.agent.prior_refs import extract_prior_track_refs
from lectorium_chat.observability.logging import bind_node_role, get_logger


log = get_logger(__name__)


# Share card stays readable at a small count; the tool itself caps at 10.
_MAX_PDF_BATCH = 5


def _unique_track_refs(refs: list[int], ctx: TurnContext) -> list[int]:
    """Keep one ref per distinct underlying track, first-seen order, capped.

    Refs come from mixed sources — catalog lecture rows (one ref per track)
    and research transcript chunks (many refs per track) — so we de-dup by
    the de-aliased track_id and drop refs that don't resolve to a track
    (verse / commentary refs carry no track_id). Returns REFS (the aliased
    `track_pdf_generate` de-aliases them back); the underlying tool also
    de-dups, but we cap here to keep the share card small."""
    seen: set[str] = set()
    out: list[int] = []
    for r in refs:
        resolved = ctx.aliases.dealias_many([r])
        tid = resolved[0] if resolved else None
        if tid and tid not in seen:
            seen.add(tid)
            out.append(r)
            if len(out) >= _MAX_PDF_BATCH:
                break
    return out


async def _resolve_pdf_track_refs(state: ChatState, ctx: TurnContext) -> list[int]:
    """Integer track refs to put PDFs for, by the priority documented above.
    Empty when nothing resolvable — the caller then emits no card and the
    synthesizer says so honestly (no fabricated marker)."""
    # 1. Anchor: the user is on a lecture / tapped a fragment.
    anchors = [
        r for r in (state.get("current_track_ref"), state.get("focus_ref"))
        if isinstance(r, int)
    ]
    if (refs := _unique_track_refs(anchors, ctx)):
        return refs

    # 2. Gather results from THIS turn (catalog lecture rows / research
    #    transcript chunks). Both carry an integer `ref`. A tool result is
    #    either a single row (dict) or a LIST of rows — `tracks_list` returns
    #    a list, appended to `tool_results` as ONE element — so flatten.
    gather: list[int] = []
    for entry in state.get("tool_results") or []:
        rows = entry if isinstance(entry, list) else [entry]
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("ref"), int):
                gather.append(row["ref"])
    if (refs := _unique_track_refs(gather, ctx)):
        return refs

    # 3. Prior-turn cards the user points at deictically. These are real
    #    catalog ids; alias them into THIS turn so the tool can de-alias back.
    prior = extract_prior_track_refs(state.get("history") or [])
    if prior:
        return _unique_track_refs([ctx.aliases.alias_track(t) for t in prior], ctx)

    # 4. The user's last-played lecture.
    if (state.get("extracted_args") or {}).get("recent_ref"):
        ul = ctx.action_tools.get("user_tracks_list")
        if ul is not None:
            rows = await ul(limit=1)
            recent = [
                r["track_ref"]
                for r in (rows or [])
                if isinstance(r, dict) and isinstance(r.get("track_ref"), int)
            ]
            if (refs := _unique_track_refs(recent, ctx)):
                return refs

    return []


async def action_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("action_worker")
    ctx = runtime.context
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "preparing_action"}})

    def _yield_event(event_type: str, data: dict[str, Any]) -> None:
        """Bridge a tool's SSE `action`/payload event to the stream, and
        record real action ids so the MarkerExpander keeps only markers
        whose id actually fired (mirror of run_worker's bridge)."""
        if event_type == "action":
            aid = data.get("id")
            if isinstance(aid, str) and aid:
                ctx.emitted_action_ids.add(aid)
        writer({"type": event_type, "data": data})

    args = state.get("extracted_args") or {}
    kind = args.get("action_kind")
    tools = ctx.action_tools
    result: dict[str, Any] | None = None

    if kind == "reminder":
        fn = tools.get("reminder_propose")
        if fn is not None:
            t = args.get("time")
            extra = {"time": t} if isinstance(t, str) and t else {}
            result = await fn(yield_event=_yield_event, **extra)
    elif kind == "smart_library":
        fn = tools.get("smart_library_propose")
        if fn is not None:
            result = await fn(yield_event=_yield_event)
    elif kind == "pro":
        fn = tools.get("pro_upgrade_propose")
        if fn is not None:
            result = await fn(reason="chat", yield_event=_yield_event)
    else:
        # Default create_action is a PDF (action_kind 'pdf' or unset legacy).
        fn = tools.get("track_pdf_generate")
        refs = await _resolve_pdf_track_refs(state, ctx)
        if fn is not None and refs:
            # `track_pdf_generate` is the aliased tool — it de-aliases the
            # integer refs back to real catalog track_ids and is already
            # bound with the catalog repo.
            result = await fn(track_ids=refs, lang=ctx.lang, yield_event=_yield_event)

    if not isinstance(result, dict) or not result.get("action_id"):
        log.info(
            "action_worker_no_card",
            request_id=ctx.request_id,
            action_kind=kind,
            had_gather=bool(state.get("tool_results")),
            error=(result or {}).get("error") if isinstance(result, dict) else None,
        )
        return {}

    log.info(
        "action_worker_card",
        request_id=ctx.request_id,
        action_kind=kind,
        action_id=result.get("action_id"),
        items=len(result.get("items") or []),
    )
    # Append (operator.add reducer) so the gather's notes stay in state too.
    return {"tool_results": [result]}

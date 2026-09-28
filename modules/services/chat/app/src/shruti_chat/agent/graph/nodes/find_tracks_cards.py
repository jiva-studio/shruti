"""Find-tracks cards: the lecture tiles and quotes streamed to the client."""

from __future__ import annotations

from shruti_chat.agent.graph.nodes._worker_common import (
    build_cite_payload,
    resolve_track_display,
)
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.domain.entities import ScoredChunk


async def renderable_cards(ctx: TurnContext, tracks) -> list[tuple[str, dict]]:
    """Resolve display attribution for each track, DROPPING any with no title —
    a catalog-less client can't render it (same invariant as the main find
    path). Returns [(track_id, payload), …] so the caller can size the lead-in
    to what will actually show and fall through when nothing is renderable."""
    out: list[tuple[str, dict]] = []
    for track in tracks:
        disp = await resolve_track_display(ctx, track.id)
        title = disp.get("track_title") or track.title
        if not title:
            continue
        out.append((track.id, {"track_id": track.id, **disp, "track_title": title}))
    return out


def stream_cards(writer, cards: list[tuple[str, dict]]) -> None:
    """Emit one card action + `[card:id]` marker per resolved card
    (payload-before-marker, honouring the SSE ordering invariant)."""
    for track_id, payload in cards:
        writer({"type": "action",
                "data": {"kind": "card", "id": track_id, "payload": payload}})
        writer({"type": "delta", "data": {"text": f"[card:{track_id}]\n\n"}})


async def emit_lecture_cards(
    ctx: TurnContext, writer, kept: list[tuple[ScoredChunk, dict, str]], descriptions: list[str],
) -> None:
    """Per lecture: its description, the card payload and `[card:]` marker, and
    the quote's cite payload and `[cite:]` marker — every payload before its
    marker, so a catalog-less client (web) can render what the marker names."""
    for (sc, disp, _description), desc_text in zip(kept, descriptions):
        chunk = sc.chunk
        tid = chunk.track_id
        if desc_text:
            writer({"type": "delta", "data": {"text": desc_text + "\n\n"}})

        # Card attribution payload — so a catalog-less client (web) can render
        # the lecture tile. Emitted BEFORE the [card:] marker.
        writer({
            "type": "action",
            "data": {"kind": "card", "id": tid, "payload": {"track_id": tid, **disp}},
        })

        ref = ctx.aliases.alias_chunk(tid, chunk.start_ms, chunk.end_ms, lang=chunk.lang)
        ctx.aliases.chunk_texts[ref] = chunk.text
        cite = await build_cite_payload(ctx, ref, ctx.aliases.resolve(ref))
        if cite is not None:
            writer({
                "type": "action",
                "data": {
                    "kind": "cite_transcript",
                    "id": f"cite_{tid}_{chunk.start_ms}_{chunk.end_ms}",
                    "payload": cite,
                },
            })

        marker = f"[card:{tid}]\n"
        if cite is not None:
            marker += f"[cite:{tid}@{chunk.start_ms}-{chunk.end_ms}]\n"
        writer({"type": "delta", "data": {"text": marker + "\n"}})

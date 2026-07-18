"""Orchestrator transcript → `reviewed` shape adapter.

The corpus indexer consumes the canonical *reviewed* transcript
(`domain/transcript/reviewed.go`):

    {"trackId", "language", "blocks": [
        {"type": "sentence", "start": ms, "end": ms, "text": str,
         "reference"?: {"sourceId": str, "tokens": [str]}},
        {"type": "verse:text", "start": ms, "end": ms, "text": [str]},
        ...
    ]}

A track added through the "add to my library" flow (#1226/#1224) is
transcribed by the orchestrator pipeline, which emits a leaner
*orchestrator transcript*: a flat list of timed `segments` (the ASR output,
timestamps in **seconds**). This module normalises that leaner shape into
the reviewed shape that `chunk_reviewed` already knows how to window, so the
private lane reuses the exact same chunker as the public corpus.

Both directions are accepted and idempotent:
- a payload that already carries `blocks` is passed through (only
  `trackId`/`language` are re-stamped to the authoritative values), so an
  orchestrator that upgrades to emitting reviewed transcripts needs no code
  change here;
- a payload with `segments` is converted to `sentence` blocks.
"""

from __future__ import annotations

from typing import Any


def _to_ms(value: Any) -> int | None:
    """Coerce a timestamp to integer milliseconds.

    Orchestrator segments carry FLOAT seconds (ASR convention); reviewed
    blocks use INT milliseconds. A float is treated as seconds (×1000); an
    int is assumed to already be milliseconds. Returns None for junk so a
    single bad segment is skipped rather than crashing the whole track.
    """
    if isinstance(value, bool):  # bool is an int subclass — reject explicitly
        return None
    if isinstance(value, float):
        return int(round(value * 1000))
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(round(float(value) * 1000)) if "." in value else int(value)
        except ValueError:
            return None
    return None


def _reference(seg: dict) -> dict | None:
    ref = seg.get("reference")
    if not isinstance(ref, dict):
        return None
    source_id = ref.get("sourceId") or ref.get("source_id")
    if not source_id:
        return None
    tokens = ref.get("tokens")
    out: dict[str, Any] = {"sourceId": source_id}
    if isinstance(tokens, list):
        out["tokens"] = tokens
    return out


def orchestrator_transcript_to_reviewed(
    payload: dict,
    *,
    track_id: str,
    lang: str,
) -> dict:
    """Adapt an orchestrator transcript payload to the `reviewed` shape.

    `track_id` / `lang` are authoritative (they come from the `track.ready`
    event / ACL, not the transcript body) and always override whatever the
    payload carries — the private lane must index under the id the ACL is
    keyed on.
    """
    if not isinstance(payload, dict):
        return {"trackId": track_id, "language": lang, "blocks": []}

    # Already-reviewed passthrough: keep the blocks verbatim, re-stamp the
    # identity fields.
    blocks = payload.get("blocks")
    if isinstance(blocks, list):
        return {"trackId": track_id, "language": lang, "blocks": blocks}

    segments = payload.get("segments")
    out_blocks: list[dict] = []
    if isinstance(segments, list):
        for seg in segments:
            if not isinstance(seg, dict):
                continue
            start = _to_ms(seg.get("start"))
            end = _to_ms(seg.get("end"))
            text = seg.get("text")
            if start is None or end is None or not isinstance(text, str):
                continue
            text = text.strip()
            if not text:
                continue
            block: dict[str, Any] = {
                "type": "sentence",
                "start": start,
                "end": max(start, end),
                "text": text,
            }
            ref = _reference(seg)
            if ref is not None:
                block["reference"] = ref
            out_blocks.append(block)

    return {"trackId": track_id, "language": lang, "blocks": out_blocks}

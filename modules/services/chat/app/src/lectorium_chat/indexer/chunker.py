"""Reviewed-transcript → ~45s windows for embedding.

Input shape (per `domain/transcript/reviewed.go`):
{
  "trackId": "...",
  "language": "ru",
  "blocks": [
    {"type": "paragraph", "start": 0, "end": 5000},
    {"type": "sentence", "start": 5000, "end": 8000,
        "text": "...", "reference": {"sourceId": "...", "tokens": [...]}},
    {"type": "verse:text", "start": 8000, "end": 12000,
        "text": ["line 1", "line 2"]},
    {"type": "verse:translation", "start": 8000, "end": 12000, "text": "..."}
  ]
}
"""

from __future__ import annotations

from dataclasses import dataclass

WINDOW_MS = 45_000
OVERLAP_BLOCKS = 2

# Hard char cap per emitted chunk. The window is bounded by TIME (45s), not
# size, so a degenerate block — e.g. a `verse:translation` carrying a whole
# translation in one zero-duration block (26k+ chars observed in prod) — would
# otherwise produce one unembeddable chunk: OpenRouter answers /embeddings with
# 200 + an empty `data` array on such oversize input (not a 429), the call
# fails after retries, the track is never marked indexed, and it re-processes
# every run. 8000 chars ≈ ~2k tokens is safely under the model limit and a sane
# retrieval granularity; well-formed 45s windows sit far below it, so only
# pathological blocks get split.
MAX_CHARS = 8000


def _split_oversize(text: str, limit: int = MAX_CHARS) -> list[str]:
    """Split text into <=limit-char pieces on whitespace boundaries.

    Falls back to a hard slice for a single token longer than the limit.
    """
    if len(text) <= limit:
        return [text]
    pieces: list[str] = []
    rest = text
    while len(rest) > limit:
        cut = rest.rfind(" ", 0, limit + 1)
        if cut <= 0:
            cut = limit
        pieces.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        pieces.append(rest)
    return [p for p in pieces if p]


@dataclass
class Chunk:
    track_id: str
    lang: str
    start_ms: int
    end_ms: int
    text: str
    reference_source_id: str | None


def _block_text(block: dict) -> str:
    t = block.get("type")
    text = block.get("text")
    if t == "verse:text" and isinstance(text, list):
        return " ".join(text)
    if isinstance(text, str):
        return text
    return ""


def _block_reference_source(block: dict) -> str | None:
    ref = block.get("reference")
    if isinstance(ref, dict):
        return ref.get("sourceId")
    return None


def chunk_reviewed(reviewed: dict) -> list[Chunk]:
    """Window-based chunker. Skips paragraph markers, overlaps by 2 blocks."""
    track_id: str = reviewed["trackId"]
    lang: str = reviewed["language"]
    raw_blocks = reviewed.get("blocks") or []
    # Skip paragraph markers — they have no text, only act as boundaries.
    blocks = [b for b in raw_blocks if b.get("type") != "paragraph"]
    if not blocks:
        return []

    out: list[Chunk] = []
    i = 0
    n = len(blocks)
    while i < n:
        win_start_idx = i
        win_start_ms = int(blocks[i]["start"])
        last_end_ms = int(blocks[i]["end"])
        texts: list[str] = []
        ref_source: str | None = None
        j = i
        while j < n:
            blk = blocks[j]
            last_end_ms = int(blk["end"])
            text = _block_text(blk).strip()
            if text:
                texts.append(text)
            if ref_source is None:
                ref_source = _block_reference_source(blk)
            # Close window if we'd exceed WINDOW_MS after this block.
            if last_end_ms - win_start_ms >= WINDOW_MS:
                j += 1
                break
            j += 1
        joined = " ".join(t for t in texts if t)
        if joined:
            for piece in _split_oversize(joined):
                out.append(Chunk(
                    track_id=track_id,
                    lang=lang,
                    start_ms=win_start_ms,
                    end_ms=last_end_ms,
                    text=piece,
                    reference_source_id=ref_source,
                ))
        if j >= n:
            break
        # Overlap: rewind 2 blocks (but always make forward progress).
        i = max(win_start_idx + 1, j - OVERLAP_BLOCKS)
    return out

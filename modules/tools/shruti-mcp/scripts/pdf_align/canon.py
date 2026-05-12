"""Build a canonical block stream from parsed PDF, and read ASR segments
in a uniform shape for the aligner.

Kept separate from align_fast.py so the data model stays explicit.
"""
from __future__ import annotations
from dataclasses import dataclass
import re
from .iast import to_iast, ascii_fold

# Conservative sentence splitter: splits on .!? followed by space + uppercase
# (or quote/paren/bracket) — protects [Bg X.Y] decimals so they don't break
# "8.12" into two sentences.
SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-ZÄÅÉÏÖÜÑÇÌ\"'\(\[])")

_JUNK_SENT_RE = re.compile(
    r"^\s*\[(?:end|break|pause|aside|laughter|laughs|chuckling|coughs?|"
    r"applause|inaudible|unclear|silence|chants?|leads?|sings?|"
    r"continues?)\]\s*$",
    re.IGNORECASE,
)

def split_sentences(text: str) -> list[str]:
    text = re.sub(r"\[(\w+)\s+([\d.\-]+)\]", lambda m: f"[{m.group(1)}~{m.group(2)}]", text)
    parts = SENT_SPLIT_RE.split(text)
    parts = [p.strip() for p in parts if p.strip()]
    parts = [re.sub(r"\[(\w+)~([\d.\-]+)\]", lambda m: f"[{m.group(1)} {m.group(2)}]", p) for p in parts]
    # Drop pure stage-direction fragments left over from sentences like
    # "Thank you very much. [end]" — after the period split, "[end]" becomes
    # its own sentence and pollutes the timeline (fill_gaps stretches it
    # over the remaining audio, sometimes minutes long).
    parts = [p for p in parts if not _JUNK_SENT_RE.match(p)]
    return parts

def dehyphenate(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()

def _split_tokens(raw: str) -> list[str]:
    # Wire shape mirrors TS Reference.tokens: array of dot-separated segments.
    # Empty/whitespace input → []; preserves order without parsing as ints.
    s = (raw or "").strip()
    return s.split(".") if s else []

@dataclass
class CanonSentence:
    text: str
    speaker: str | None
    ref: tuple | None      # (sourceId, tokens) or None
    para_idx: int
    pos_in_para: int
    is_last_in_para: bool

@dataclass
class CanonVerse:
    lines: list[str]
    ref: tuple | None

@dataclass
class CanonTranslation:
    text: str

def build_canonical(parsed: dict) -> list:
    """Flatten parsed PDF blocks into a CanonSentence|CanonVerse|CanonTranslation
    stream. Splits paragraphs into sentences; propagates speaker forward and
    attaches inline-ref to the last sentence of its paragraph; drops empty
    paragraphs (e.g. a speaker label with no body line yet)."""
    out = []
    pending_speaker = None
    for pi, b in enumerate(parsed["blocks"]):
        kind = b["kind"]
        if kind == "para":
            speaker = b.get("speaker") or pending_speaker
            ref     = b.get("ref")
            joined  = dehyphenate(" ".join(b["lines"]))
            sents   = [s for s in split_sentences(joined) if s.strip()]
            if not sents:
                if b.get("speaker"): pending_speaker = b["speaker"]
                continue
            pending_speaker = speaker
            n = len(sents)
            for j, s in enumerate(sents):
                out.append(CanonSentence(
                    text=s,
                    speaker=speaker,
                    ref=(ref if (j == n-1 and ref) else None),
                    para_idx=pi,
                    pos_in_para=j,
                    is_last_in_para=(j == n-1),
                ))
        elif kind == "verse":
            out.append(CanonVerse(lines=list(b["lines"]), ref=b.get("ref")))
        elif kind == "trans":
            out.append(CanonTranslation(text=b["text"]))
    return out

def asr_segments(asr: dict):
    """Yield (start_ms, end_ms, text, ascii_fold) per ASR segment.
    Accepts either:
      - raw transcriber output : {"segments": [{idx, start, end, text, confidence}]}
      - public en.json schema  : {"blocks": [{type:"sentence", start, end, text}]}
    Tolerates an empty/null segments list (Whisper can return zero segments
    on silence-only audio); the caller's `if not asr_list` short-circuits
    to an empty transcript instead of erroring out."""
    segs = asr.get("segments") or []
    if segs:
        for s in segs:
            t = (s.get("text") or "").strip()
            if not t: continue
            yield (s["start"], s["end"], t, ascii_fold(t))
        return
    for b in asr.get("blocks", []) or []:
        if b.get("type") != "sentence": continue
        yield (b["start"], b["end"], b["text"], ascii_fold(b["text"]))

def to_v2_blocks(canon, aligned) -> list[dict]:
    """Render aligned canon into final v2 transcript blocks (sentence,
    verse:text, verse:translation). References here still carry the raw
    PDF source label; align_fast normalizes them after this step."""
    out = []
    for c, a in zip(canon, aligned):
        s, e = a["start"], a["end"]
        if isinstance(c, CanonSentence):
            blk = {"type": "sentence", "start": s, "end": e, "text": to_iast(c.text)}
            if c.speaker: blk["speaker"] = to_iast(c.speaker)
            if c.ref:     blk["reference"] = {"sourceId": c.ref[0], "tokens": _split_tokens(c.ref[1])}
            out.append(blk)
        elif isinstance(c, CanonVerse):
            blk = {"type": "verse:text", "start": s, "end": e,
                   "text": [to_iast(l) for l in c.lines]}
            if c.ref:     blk["reference"] = {"sourceId": c.ref[0], "tokens": _split_tokens(c.ref[1])}
            out.append(blk)
        else:  # translation
            out.append({"type": "verse:translation", "start": s, "end": e,
                        "text": to_iast(c.text)})
    return out

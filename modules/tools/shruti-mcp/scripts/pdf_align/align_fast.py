"""Align canonical PDF blocks to noisy ASR segments using
difflib.SequenceMatcher (Ratcliff/Obershelp, C impl).

Approach:
  1. Build canonical block stream from PDF (sentences/verses/translations).
  2. Flatten BOTH sides to token streams:
     - PDF tokens carry (canon_idx) so we know which sentence each came from.
     - ASR tokens carry (seg_idx) so we know which timed segment each came from.
  3. SequenceMatcher.get_matching_blocks() returns all common substrings
     between the two streams (linear-ish in N+M on typical inputs).
  4. For each canon sentence, intersect its PDF token range with matched
     blocks, look up the ASR segments those matched tokens fell into, and
     take {min start, max end} as the sentence's time window.
  5. Normalize source labels to canonical DB IDs; pull inline [Bg X.Y]
     citations out of sentence text into the `reference` field.
  6. Monotonic clamp on adjacent block timestamps so the timeline never
     goes backwards (some sentences may match overlapping ASR windows).

Empirical: ~50ms per track on a 600-segment ASR vs 300-sentence canon.
"""
from __future__ import annotations
from difflib import SequenceMatcher
import re
from .iast import to_iast, ascii_fold
from .canon import (build_canonical, asr_segments, to_v2_blocks,
                    CanonSentence, CanonVerse, CanonTranslation)
from .sources import resolve as resolve_source, find_inline as find_inline_refs

WORD_RE = re.compile(r"[a-z0-9']+")

def tokenize(s: str) -> list[str]:
    return WORD_RE.findall(ascii_fold(s))

def _flatten_canon(canon):
    """Yield (token, canon_idx) for each canon sentence/verse, skipping
    translations (they aren't spoken so they shouldn't compete for ASR matches)."""
    pdf_tokens, pdf_owners = [], []
    for ci, c in enumerate(canon):
        if isinstance(c, CanonSentence):
            text = c.text
        elif isinstance(c, CanonVerse):
            text = " ".join(c.lines)
        else:
            continue
        for tok in tokenize(text):
            pdf_tokens.append(tok)
            pdf_owners.append(ci)
    return pdf_tokens, pdf_owners

def _flatten_asr(asr_segs):
    asr_tokens, asr_owners = [], []
    for si, (s, e, text, folded) in enumerate(asr_segs):
        for tok in tokenize(text):
            asr_tokens.append(tok)
            asr_owners.append(si)
    return asr_tokens, asr_owners

def align_track_fast(parsed: dict, asr: dict) -> dict:
    canon = build_canonical(parsed)
    asr_list = list(asr_segments(asr))
    track_id = asr.get("trackId") or asr.get("track_id") or ""
    language = asr.get("language", "en")
    if not asr_list:
        return {"trackId": track_id, "language": language, "version": 2, "blocks": []}

    pdf_toks, pdf_own = _flatten_canon(canon)
    asr_toks, asr_own = _flatten_asr(asr_list)

    sm = SequenceMatcher(a=pdf_toks, b=asr_toks, autojunk=False)
    matching = sm.get_matching_blocks()

    n_canon = len(canon)
    seg_lo = [None]*n_canon
    seg_hi = [None]*n_canon
    matched_tokens = [0]*n_canon

    for i, j, n in matching:
        if n == 0: continue
        for off in range(n):
            ci = pdf_own[i+off]
            si = asr_own[j+off]
            matched_tokens[ci] += 1
            if seg_lo[ci] is None or si < seg_lo[ci]:
                seg_lo[ci] = si
            if seg_hi[ci] is None or si > seg_hi[ci]:
                seg_hi[ci] = si

    aligned = []
    for ci, c in enumerate(canon):
        if isinstance(c, CanonSentence):
            key_toks = len(tokenize(c.text))
            mt = matched_tokens[ci]
            # require either >=3 absolute tokens matched OR >=50% of canon
            # tokens matched, to count as a confident "direct" match.
            if seg_lo[ci] is not None and (mt >= 3 or mt >= 0.5*key_toks):
                aligned.append({
                    "start": asr_list[seg_lo[ci]][0],
                    "end":   asr_list[seg_hi[ci]][1],
                })
            else:
                aligned.append({"start": None, "end": None})
        elif isinstance(c, CanonVerse):
            if seg_lo[ci] is not None:
                aligned.append({"start": asr_list[seg_lo[ci]][0],
                                "end":   asr_list[seg_hi[ci]][1]})
            else:
                aligned.append({"start": None, "end": None})
        else:  # translation
            aligned.append({"start": None, "end": None})

    # Fill gaps for unmatched blocks honestly: each unmatched block gets
    # a zero-width marker (start == end) placed inside the gap between its
    # surrounding matched neighbours. We don't pretend to know when an
    # unspoken / unmatched sentence happened — guessing "the last 60s"
    # is a fiction that pollutes the player. Zero-width means: text is
    # visible in transcript view, no highlight in the audio player.
    #
    # When several unmatched sit in the same gap (e.g. PDF has a paragraph
    # that ASR completely missed), distribute them evenly across the gap
    # so each gets its own (still zero-width) placement, not a stack on
    # one identical timestamp.
    total_dur = asr_list[-1][1] if asr_list else (parsed.get("duration_ms") or 0)
    n = len(aligned)
    # Walk runs of unmatched blocks and place each at an evenly spaced
    # midpoint within the surrounding gap.
    i = 0
    while i < n:
        if aligned[i]["start"] is not None and aligned[i]["end"] is not None:
            i += 1
            continue
        # find the run [i .. j-1] of unmatched blocks
        j = i
        while j < n and (aligned[j]["start"] is None or aligned[j]["end"] is None):
            j += 1
        # boundary anchors
        gap_start = aligned[i-1]["end"] if i > 0 and aligned[i-1]["end"] is not None else 0
        gap_end   = aligned[j]["start"] if j < n and aligned[j]["start"] is not None else total_dur
        if gap_end < gap_start:  # safety: collapsed boundary
            gap_end = gap_start
        run_len = j - i
        for k, idx in enumerate(range(i, j)):
            # k=0..run_len-1 → fractional position (k+1)/(run_len+1) inside gap
            frac = (k + 1) / (run_len + 1)
            t = int(gap_start + frac * (gap_end - gap_start))
            aligned[idx]["start"] = t
            aligned[idx]["end"]   = t
        i = j

    # Rescue zero-width sentences: a sentence with start==end means the
    # neighbour-inherited boundaries collapsed (its tokens didn't match
    # anything in difflib's pass). Try to find an ASR segment near the
    # collapse point whose text contains >=50% of the canon sentence's
    # tokens, and adopt that segment's [start,end]. Catches inline
    # citations, short interjections, and "yes/no" replies that ASR
    # subsumed into a longer neighbouring utterance.
    from bisect import bisect_right
    asr_starts = [s[0] for s in asr_list]
    for ci, c in enumerate(canon):
        if not isinstance(c, CanonSentence): continue
        if aligned[ci]["start"] != aligned[ci]["end"]: continue
        target = aligned[ci]["start"]
        key_tokens = set(tokenize(c.text))
        if not key_tokens: continue
        # Probe ASR segments in a small window around `target` (up to ±3)
        pivot = bisect_right(asr_starts, target) - 1
        best = None
        best_overlap = 0
        for k in range(max(0, pivot - 3), min(len(asr_list), pivot + 4)):
            asr_toks = set(asr_list[k][3].split())
            if not asr_toks: continue
            overlap = len(key_tokens & asr_toks)
            if overlap > best_overlap and overlap >= 0.5 * len(key_tokens):
                best_overlap = overlap
                best = k
        if best is not None:
            aligned[ci]["start"] = asr_list[best][0]
            aligned[ci]["end"]   = asr_list[best][1]

    blocks = to_v2_blocks(canon, aligned)

    # Normalize references to canonical DB source IDs. Pick up inline
    # [Bg X.Y] citations inside sentence text and attach them as `reference`
    # when the sentence has none. Sources not in the DB get a "raw__<label>"
    # sourceId so the UI can still display them while we add them to the DB.
    # `resolve_source` and `find_inline_refs` work in dot-joined strings; the
    # public wire shape is an array (mirrors TS Reference.tokens). Join on the
    # way in, split on the way out.
    def _toks(s: str) -> list[str]:
        s = (s or "").strip()
        return s.split(".") if s else []

    for b in blocks:
        ref = b.get("reference")
        if ref:
            raw_tokens = ref.get("tokens", "")
            if isinstance(raw_tokens, list):
                raw_tokens = ".".join(raw_tokens)
            canon_id, tokens = resolve_source(ref.get("sourceId",""), raw_tokens)
            if canon_id:
                b["reference"] = {"sourceId": canon_id, "tokens": _toks(tokens)}
            else:
                b["reference"] = {"sourceId": "raw__" + ref.get("sourceId","").strip(),
                                  "tokens": _toks(tokens)}
        elif b["type"] == "sentence":
            hits = find_inline_refs(b.get("text",""))
            if hits:
                _, _, canon_id, raw_src, tokens = hits[0]
                if canon_id:
                    b["reference"] = {"sourceId": canon_id, "tokens": _toks(tokens)}
                else:
                    b["reference"] = {"sourceId": "raw__" + raw_src.strip(),
                                      "tokens": _toks(tokens)}

    # Monotonic clamp: difflib emits a global match, so two adjacent canon
    # sentences can land on overlapping ASR ranges. Walk the timeline and
    # clamp next.start to prev.end whenever it goes backwards.
    for i in range(1, len(blocks)):
        prev_end = blocks[i-1].get("end")
        if prev_end is None: continue
        if blocks[i].get("start") is not None and blocks[i]["start"] < prev_end:
            blocks[i]["start"] = prev_end
        if blocks[i].get("end") is not None and blocks[i]["end"] < blocks[i]["start"]:
            blocks[i]["end"] = blocks[i]["start"]

    return {
        "trackId":  track_id,
        "language": language,
        "version":  2,
        "blocks":   blocks,
    }

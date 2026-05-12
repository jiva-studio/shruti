"""Parse a transcript PDF (Prabhupada lectures, ScaGoudy-family layout) into
a sequence of *logical* blocks: speaker-paragraphs, verses, translations.

Output is intermediate (no timestamps yet); align_fast adds timing later.
Block dicts produced:
  {"kind": "para",  "speaker": str|None, "lines": [...], "ref": (src, tokens)|None}
  {"kind": "verse", "lines": [str, ...],                "ref": (src, tokens)|None}
  {"kind": "trans", "text": str}
"""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import re
import fitz

# === Regexes ==========================================================
REF_FULL_RE  = re.compile(r"^\[(Bg|SB|Bs|Cc|NoI|Iso|MM|BG|CC|Hari|TLC|NBS|NoD|Brs|MoI)\b\s*([^\]]*)\]$")
SPEAKER_RE      = re.compile(r"^([A-ZÄÅÉÏÖÜÑÇ][\w'’ä-üÄ-Ü .]{1,50}):\s")
SPEAKER_ONLY_RE = re.compile(r"^([A-ZÄÅÉÏÖÜÑÇ][\w'’ä-üÄ-Ü .]{1,50}):\s*$")
PAGENUM_RE   = re.compile(r"^\d+$")
# Audio-ID line, several formats observed:
#   661026BG-NEW YORK  [36:29 Minutes]
#   CcMadhya-06.154_751124CC-BOMBAY
#   BG-16.07_750203BG-HONOLULU
#   Brahma-samhita-Lecture_710726BS-NEW YORK
# All contain the YYMMDD code-pair "[_]?\d{6}[A-Z]+-" somewhere.
AUDIO_ID_RE  = re.compile(r"(?:^|_)\d{6}[A-Z]+-")
DURATION_RE  = re.compile(r"\[(\d+):(\d+)\s*Minutes\]")
# Stage directions: short bracketed annotations like [break], [pause],
# [01:53], [aside:], [crashing sound] — never speech, must NOT be classified
# as translation.
STAGE_KEYWORDS = re.compile(
    r"^\[(?:break|pause|aside|end|begin|chants?|leads?|devotees?|crashing|"
    r"sound|applause|laughs?|laughter|coughs?|sings?|continues?|silence|"
    r"loud|noise|music|inaudible|unclear|recording|sic|prema|kīrtana|"
    r"chuckling|snickering|whispers?|whispered|tapping|microphone|"
    r"speaks|interrupting|interrupted|asks?|repeating|repeats?|repeated|"
    r"\d{1,3}:\d{2}|\d+\s*minutes?|harāv|hare\s+kṛṣṇa)\b",
    re.IGNORECASE,
)

# === Span/line helpers =================================================
def is_italic(span):
    return ("Italic" in span["font"]) or (span["flags"] & 2) != 0
def is_bold(span):
    return ("Bold" in span["font"]) or (span["flags"] & 16) != 0

def span_classify(line, page_w):
    spans = line["spans"]
    txt = "".join(s["text"] for s in spans).strip()
    if not txt:
        return None
    bbox = line["bbox"]
    left, right = bbox[0], bbox[2]
    centered  = (abs(((left+right)/2) - page_w/2) < 30) and left > 90
    fullwidth = (left < 90) and (right > 400)
    short_left = (left < 90) and (right < 400)
    has_ital = any(is_italic(s) for s in spans)
    has_bold = any(is_bold(s) for s in spans)
    has_reg  = any((not is_italic(s)) and (not is_bold(s)) for s in spans)
    big      = any(round(s["size"]) >= 16 for s in spans)
    arial    = any("Arial" in s["font"] for s in spans)
    return {
        "text": txt, "bbox": bbox, "left": left, "right": right,
        "centered": centered, "fullwidth": fullwidth, "short_left": short_left,
        "ital": has_ital, "bold": has_bold, "reg": has_reg,
        "big": big, "arial": arial,
        "spans": spans,
    }

def classify_line(L) -> str:
    t = L["text"]
    if PAGENUM_RE.match(t) and L["centered"]: return "PAGE_NUM"
    # AUDIO_ID_RE may sit anywhere on the line (some PDFs prefix it with
    # "Initiation_", "Lecture_", or split "LOS ANGELES" onto its own short
    # caps-only fragment). search() catches the embedded form; the regex's
    # `(?:^|_)\d{6}[A-Z]+-` anchor keeps false positives off normal prose.
    if AUDIO_ID_RE.search(t): return "AUDIO_ID"
    # Bare trailing chunk of the audio-id like "LOS ANGELES" or "ANGELES"
    # — short, all-caps (with spaces), bold, at the left margin and not in
    # a sentence tail. Drop these as residual header noise.
    if (not L["centered"]) and L["spans"] and is_bold(L["spans"][0]) \
            and len(t) < 30 and t.upper() == t and not any(c.isdigit() for c in t):
        return "AUDIO_ID"
    if t == "Audio" and L["arial"]: return "AUDIO_LBL"
    if L["big"] and L["bold"] and L["centered"]: return "HEADER"
    if L["centered"] and REF_FULL_RE.match(t.strip()):
        return "SHLOKA_REF_CENTERED"
    stripped = t.strip().rstrip(".,;:")
    if (not L["centered"]) and REF_FULL_RE.match(stripped):
        return "INLINE_REF_LINE"
    if L["centered"] and L["ital"] and not L["reg"] and not L["bold"]:
        return "SHLOKA_LINE"
    # Speaker open: bold "Name:" at the start of any non-centered line.
    # The earlier `fullwidth` requirement was too strict — short paragraphs
    # like "Prabhupāda: [tapping on microphone]" wrap to <400px and would
    # slip through; bold-first-span at left margin is the real classifier.
    if (not L["centered"]) and L["spans"] and is_bold(L["spans"][0]):
        if SPEAKER_RE.match(t) or SPEAKER_ONLY_RE.match(t):
            return "SPEAKER_OPEN"
    if t.startswith("[") and not REF_FULL_RE.match(t):
        bracketed_len = len(t)
        if bracketed_len < 60 and STAGE_KEYWORDS.match(t):
            return "STAGE"
        if bracketed_len < 60 and t.endswith("]"):
            inner = t[1:-1].strip()
            if inner and (inner[0].islower() or inner[0].isdigit()):
                return "STAGE"
        return "TRANSLATION"
    return "BODY"

# === Block builder ====================================================
@dataclass
class Para:
    speaker: str | None = None
    lines: list[str] = field(default_factory=list)
    ref: tuple | None = None       # ("Bg", "8.10") if inline ref trailer found

@dataclass
class Verse:
    lines: list[str] = field(default_factory=list)
    ref: tuple | None = None

@dataclass
class Translation:
    text: str = ""

def parse_pdf(pdf_path: Path) -> dict:
    doc = fitz.open(pdf_path)
    page_w = doc[0].rect.width
    classified = []
    for page in doc:
        for blk in page.get_text("dict").get("blocks", []):
            if blk.get("type") != 0: continue
            for line in blk.get("lines", []):
                L = span_classify(line, page_w)
                if not L: continue
                classified.append((classify_line(L), L))
    doc.close()

    duration_ms = None
    header_lines = []
    body = []
    for tag, L in classified:
        if tag == "AUDIO_ID":
            m = DURATION_RE.search(L["text"])
            if m: duration_ms = int(m.group(1))*60_000 + int(m.group(2))*1000
            continue
        if tag in ("PAGE_NUM", "AUDIO_LBL"):
            continue
        if tag == "HEADER":
            header_lines.append(L["text"])
            continue
        body.append((tag, L))

    blocks = []
    cur_para: Para | None = None
    cur_verse: Verse | None = None
    in_translation = False
    trans_buf = []
    bracket_depth = 0
    # Speaker once explicitly set sticks across intervening verses /
    # translations / page-spanning paragraphs until a new SPEAKER_OPEN
    # appears. PDFs typically only label the speaker on the very first
    # paragraph; expecting every block-after-shloka to also be labelled
    # would silently drop attribution for most of the lecture.
    pending_speaker: str | None = None

    def flush_para():
        nonlocal cur_para
        if cur_para and cur_para.lines:
            blocks.append(("para", cur_para))
        cur_para = None

    def flush_verse():
        nonlocal cur_verse
        if cur_verse and cur_verse.lines:
            blocks.append(("verse", cur_verse))
        cur_verse = None

    def close_translation_if_done(force=False):
        nonlocal in_translation, trans_buf, bracket_depth
        if not in_translation: return
        joined = " ".join(trans_buf).strip()
        if force or bracket_depth <= 0:
            t = joined
            if t.startswith("["): t = t[1:]
            if t.endswith("]"):   t = t[:-1]
            blocks.append(("trans", Translation(text=t.strip())))
            in_translation = False; trans_buf = []; bracket_depth = 0

    for tag, L in body:
        text = L["text"]

        if in_translation:
            trans_buf.append(text)
            bracket_depth += text.count("[") - text.count("]")
            if bracket_depth <= 0:
                close_translation_if_done()
            continue

        if tag == "STAGE":
            continue

        if tag == "TRANSLATION":
            flush_para(); flush_verse()
            in_translation = True
            trans_buf = [text]
            bracket_depth = text.count("[") - text.count("]")
            if bracket_depth <= 0:
                close_translation_if_done()
            continue

        if tag == "SHLOKA_LINE":
            flush_para()
            if cur_verse is None:
                cur_verse = Verse()
            cur_verse.lines.append(text)
            continue

        if tag == "SHLOKA_REF_CENTERED":
            m = REF_FULL_RE.match(text.strip())
            if m and cur_verse is not None:
                cur_verse.ref = (m.group(1), m.group(2).strip())
            flush_verse()
            continue

        if tag == "INLINE_REF_LINE":
            m = REF_FULL_RE.match(text.strip().rstrip(".,;:"))
            if m and cur_para is not None:
                cur_para.ref = (m.group(1), m.group(2).strip())
            continue

        if tag == "SPEAKER_OPEN":
            flush_para(); flush_verse()
            m = SPEAKER_RE.match(text) or SPEAKER_ONLY_RE.match(text)
            speaker = m.group(1).strip() if m else None
            if speaker:
                pending_speaker = speaker
            rest = text[m.end():].strip() if (m and SPEAKER_RE.match(text)) else ""
            cur_para = Para(speaker=speaker, lines=[rest] if rest else [])
            continue

        if tag == "BODY":
            flush_verse()
            if cur_para is None:
                cur_para = Para(speaker=pending_speaker)
            cur_para.lines.append(text)
            continue

    if in_translation:
        close_translation_if_done(force=True)
    flush_para(); flush_verse()

    return {
        "header_lines": header_lines,
        "duration_ms": duration_ms,
        "blocks": [{"kind": k, **vars(v)} for k, v in blocks],
    }

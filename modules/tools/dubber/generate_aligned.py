import json, re, unicodedata, difflib
from pathlib import Path

UTTERANCES_PATH = "./data/deepgram_response.json"
PROOFREAD_PATH  = "./data/en.json"
OUTPUT_PATH     = "aligned.txt"

# ---------- helpers ----------
def strip_diacritics(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFD", s)
                   if not unicodedata.combining(ch))

def normalize_word(w: str) -> str:
    w = strip_diacritics(w).lower()
    return re.sub(r"_", "", w)  # remove underscores

WORD_RE = re.compile(r"\w+", re.UNICODE)  # token = word-chars only

def tokenize_with_maps(original_text: str):
    """
    Returns:
      tokens: list of dicts {start, end, orig, norm}
      norm_join: ' ' joined normalized words
    """
    tokens = []
    for m in WORD_RE.finditer(original_text):
        start, end = m.span()
        orig = original_text[start:end]
        norm = normalize_word(orig)
        if norm:
            tokens.append({"start": start, "end": end, "orig": orig, "norm": norm})
    norm_join = " ".join(t["norm"] for t in tokens)
    return tokens, norm_join

def utter_norm_words(utt_text: str):
    return [normalize_word(w) for w in WORD_RE.findall(utt_text) if normalize_word(w)]

def seq_ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()

# ---------- main ----------
def main():
    utterances = json.loads(Path(UTTERANCES_PATH).read_text(encoding="utf-8"))["results"]["utterances"]
    blocks = json.loads(Path(PROOFREAD_PATH).read_text(encoding="utf-8"))["blocks"]

    def get_text(text_field):
        if isinstance(text_field, str):
            return text_field
        if isinstance(text_field, list):
            return " ".join(text_field)

    gold_text = " ".join(get_text(b["text"]).strip() for b in blocks if get_text(b.get("text")))
    gold_tokens, _ = tokenize_with_maps(gold_text)

    gold_norm_words = [t["norm"] for t in gold_tokens]

    # Build utterance items
    utt_items = []
    for u in utterances:
        words = utter_norm_words(u.get("transcript", "") or "")
        if not words:
            continue
        utt_items.append({"start": u["start"], "end": u["end"], "words": words})

    cut_positions = []  # list of (char_pos, time)
    cursor_tok = 0

    for item in utt_items:
        needle = item["words"]
        L = max(1, len(needle))
        lens_to_try = sorted(set([
            max(1, int(L * 0.8)),
            L,
            max(1, int(L * 1.2)),
            max(L, int(L * 1.6))
        ]))

        best = None  # (ratio, tok_index, win_len)
        step = 1 if L < 20 else 2
        search_limit = min(len(gold_norm_words), cursor_tok + max(300, L * 10))
        needle_str = " ".join(needle)

        for win_len in lens_to_try:
            i = cursor_tok
            while i < search_limit:
                j = min(len(gold_norm_words), i + win_len)
                cand_str = " ".join(gold_norm_words[i:j])
                r = seq_ratio(needle_str, cand_str)
                if best is None or r > best[0]:
                    best = (r, i, win_len)
                i += step

        if best and best[0] >= 0.35:
            tok_idx = best[1]
        else:
            remain = max(1, len(gold_norm_words) - cursor_tok)
            remain_utts = max(1, len(utt_items) - len(cut_positions))
            tok_idx = min(len(gold_norm_words) - 1, cursor_tok + remain // remain_utts)

        tok_idx = max(tok_idx, cursor_tok)
        tok_idx = min(tok_idx, len(gold_tokens) - 1)
        char_pos = gold_tokens[tok_idx]["start"]

        # enforce strictly increasing char positions
        if cut_positions and char_pos <= cut_positions[-1][0]:
            last_cut_pos = cut_positions[-1][0]
            nxt = tok_idx + 1
            while nxt < len(gold_tokens) and gold_tokens[nxt]["start"] <= last_cut_pos:
                nxt += 1
            if nxt < len(gold_tokens):
                char_pos = gold_tokens[nxt]["start"]
                tok_idx = nxt
            else:
                char_pos = len(gold_text)

        cut_positions.append((char_pos, item["start"]))
        cursor_tok = min(tok_idx + max(1, L // 3), len(gold_tokens) - 1)

    # Deduplicate & sort
    cut_positions.sort(key=lambda x: x[0])
    dedup = []
    last = -1
    for pos, t in cut_positions:
        if pos <= last:
            continue
        dedup.append((pos, t))
        last = pos
    cut_positions = dedup

    # Insert markers
    out_parts = []
    prev = 0
    for pos, t in cut_positions:
        pos = max(0, min(pos, len(gold_text)))
        if pos > prev:
            out_parts.append(gold_text[prev:pos])
        out_parts.append(f"({t}) ")
        prev = pos
    if prev < len(gold_text):
        out_parts.append(gold_text[prev:])

    final_text = "".join(out_parts)
    final_text = re.sub(r"\s+([,.;:!?])", r"\1", final_text)
    final_text = re.sub(r"\s{2,}", " ", final_text).strip()

    Path(OUTPUT_PATH).write_text(final_text, encoding="utf-8")
    print(f"✅ Wrote {OUTPUT_PATH}")

if __name__ == "__main__":
    main()

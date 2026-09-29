"""Recovering a model's answer from the wrapping small models put around it."""

from __future__ import annotations


def extract_json_object(text: str) -> str | None:
    """Pull the first balanced JSON object/array out of a model response.

    Models routinely emit valid JSON wrapped in a ```json fence and/or
    surrounded by prose ("Вот сгенерированный JSON:" … / "Hope this helps!").
    A strict JSON parser chokes on the first non-JSON character. Scan to the
    first `{`/`[`, walk to its matching close (string- and escape-aware so
    braces inside string values don't fool it), and return just that slice.
    Returns None when there's no JSON-looking object at all (genuine prose /
    refusal), so the caller can fail cleanly into retry/fallback.
    """
    if not text:
        return None
    start = next((i for i, c in enumerate(text) if c in "{["), None)
    if start is None:
        return None
    open_ch = text[start]
    close_ch = "}" if open_ch == "{" else "]"
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def strip_plain_text(text: str) -> str:
    """Clean a plain-text prose reply from a cheap model. Small models
    sometimes wrap a one-liner in a ``` fence or matching quotes even when
    not asked to. Strip one such layer so the card/intro reads clean.
    """
    s = text.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        s = (s[nl + 1 :] if nl != -1 else "").strip()
        if s.endswith("```"):
            s = s[:-3].strip()
    # One layer of symmetric wrapping quotes ("…", '…', «…», “…”).
    _PAIRS = {'"': '"', "'": "'", "«": "»", "“": "”"}
    if len(s) >= 2 and s[0] in _PAIRS and s[-1] == _PAIRS[s[0]]:
        s = s[1:-1].strip()
    return s

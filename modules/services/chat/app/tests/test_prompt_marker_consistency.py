"""Prompt ↔ MarkerExpander consistency check.

This test catches the prod regression from 2026-05-20: a prompt change
told the LLM to emit `[verse:source_id/tokens|caption]` directly, but
the expander only accepts `[verse:N|...]` with integer ref. The
expander silently dropped every verse marker.

Rule: any marker example in a `prompts/*.md` or `proactive_prompts/*.md`
that's positioned as "the LLM's output" (i.e. instructional format)
MUST use an integer ref or the `N` placeholder. The pre-expanded form
(`track_id@start-end` for cite, `source_id/tokens` for verse) is
allowed only in EXAMPLES that explicitly mark themselves as "what the
client sees" or appear in code/comment contexts.

Heuristic: we forbid any `[cite|card|outline|verse:<non-integer>` token
in lines that contain "your reply" / "example" / "MUST emit" framing —
those are LLM-output examples. Lines that document server-side
expansion ("server expands → ...") are skipped explicitly.
"""

from __future__ import annotations

import re
from pathlib import Path

PROMPTS_ROOT = Path(__file__).parents[1] / "src" / "shruti_chat" / "agent"
DIRS = ["prompts", "proactive_prompts"]

# Match every [cite|card|outline|verse:<content>] marker; capture kind + body.
_MARKER_RE = re.compile(r"\[(cite|card|outline|verse):([^\]\s][^\]]*)\]")

# A marker body the LLM is allowed to produce: integer or the `N` placeholder.
# Optional `|caption` is fine.
_LLM_OUTPUT_RE = re.compile(
    r"^(?:N|\d+)(?:\|[^\]]*)?$"
)

# Body shapes the SERVER produces after expansion — allowed in docs/examples
# clearly marked as "what the client sees", but NOT in LLM-output samples.
_EXPANDED_BODY_RES = [
    re.compile(r"^[A-Za-z0-9_]+@\d+-\d+(?:\|[^\]]*)?$"),       # cite: track@from-to
    re.compile(r"^[A-Za-z0-9_]+/[0-9.,\-]+(?:\|[^\]]*)?$"),     # verse: source/tokens
    re.compile(r"^[A-Za-z0-9_]+$"),                            # card/outline: bare track_id
]

# Action markers are server-routed (id=...); not the expander's job — skip.
_ACTION_RE = re.compile(r"\[action:[^\]]+\]")


def _is_expansion_doc_line(line: str) -> bool:
    """True if the line is describing server-side expansion (`server expands →`)
    rather than telling the LLM what to write. Those mentions of expanded forms
    are correct documentation, not bad examples."""
    lo = line.lower()
    return (
        "server expand" in lo
        or "expands to" in lo
        or "→" in line and ("expand" in lo or "client" in lo)
        or "before the client" in lo
        or "before the marker reaches the client" in lo
        or "what the client sees" in lo
    )


def _is_llm_output_context(line: str, file_text: str, pos: int) -> bool:
    """Conservatively decide if a marker appears in an "LLM output" context."""
    lo = line.lower()
    # Direct instructions.
    direct = (
        "your reply" in lo
        or "your job" in lo
        or "must emit" in lo
        or "must use" in lo
        or "must come" in lo
        or "you cite it" in lo
        or "embed" in lo and "marker" in lo
        or "write" in lo and "marker" in lo
    )
    if direct:
        return True
    # Look backward up to ~250 chars for a fenced `[your reply]` header.
    window = file_text[max(0, pos - 400) : pos]
    return "[your reply" in window.lower()


def _gather_md_files() -> list[Path]:
    files: list[Path] = []
    for d in DIRS:
        files.extend(sorted((PROMPTS_ROOT / d).glob("*.md")))
    return files


def test_md_files_exist() -> None:
    files = _gather_md_files()
    assert files, "No prompt .md files found — path likely wrong."


def test_no_llm_output_example_uses_expanded_form() -> None:
    """The smoking gun: an LLM-output example like
    `[verse:source_id/tokens|caption]` would have caught the 2026-05-20
    regression. Asserts no instructional example uses server-only form.
    """
    offenders: list[str] = []
    for f in _gather_md_files():
        text = f.read_text(encoding="utf-8")
        for line_no, line in enumerate(text.splitlines(), start=1):
            if _is_expansion_doc_line(line):
                continue
            for m in _MARKER_RE.finditer(line):
                body = m.group(2)
                # Action handled elsewhere.
                if line.lstrip().startswith("[action:"):
                    continue
                if _LLM_OUTPUT_RE.match(body):
                    continue
                # Body uses an expanded shape (server-side). OK only outside
                # LLM-output instructions.
                pos = text.find(line)
                in_llm_ctx = _is_llm_output_context(line, text, pos)
                if in_llm_ctx and any(rx.match(body) for rx in _EXPANDED_BODY_RES):
                    offenders.append(
                        f"{f.name}:{line_no}  body={body!r}\n    line: {line.strip()}"
                    )
    assert not offenders, (
        "These prompt examples instruct the LLM to emit server-expanded "
        "marker forms — the MarkerExpander will drop them as "
        "hallucinations:\n\n" + "\n\n".join(offenders)
    )


def test_every_verse_marker_example_uses_integer_or_placeholder() -> None:
    """Tighter check specifically for verse markers — the regressed surface.
    Anywhere a `[verse:...]` appears as an LLM-output example, the body
    must be `N` or a digit run."""
    offenders: list[str] = []
    for f in _gather_md_files():
        text = f.read_text(encoding="utf-8")
        for line_no, line in enumerate(text.splitlines(), start=1):
            if _is_expansion_doc_line(line):
                continue
            for m in _MARKER_RE.finditer(line):
                if m.group(1) != "verse":
                    continue
                body = m.group(2)
                pos = text.find(line)
                in_llm_ctx = _is_llm_output_context(line, text, pos)
                if not in_llm_ctx:
                    continue
                if not _LLM_OUTPUT_RE.match(body):
                    offenders.append(
                        f"{f.name}:{line_no}  body={body!r}\n    line: {line.strip()}"
                    )
    assert not offenders, (
        "Verse marker examples must teach the LLM to write [verse:N|...] "
        "(integer ref) — anything else gets dropped server-side:\n\n"
        + "\n\n".join(offenders)
    )

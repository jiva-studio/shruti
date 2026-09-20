"""`eval/sse_probe.py` — the shared SSE parser, pinned on Cyrillic.

The probe lives in `modules/services/chat/eval/`, one level above the pytest
root, so nothing here collected it and its only regression — the answer text —
was unguarded. It is loaded by path below rather than moved: `run_eval.py` and
the `chat-sse-probe` skill both invoke it as `eval/sse_probe.py`.

What is being pinned: `/chat` serialises its frames with `ensure_ascii=False`
(`api/chat.py`), so a Russian delta arrives as raw UTF-8 inside the `data:`
line. The skill's old private copy of this parser decoded deltas with
`.encode().decode("unicode_escape")`, which reads those bytes as latin-1 and
turns `Прахлада` into `ÐŸÑ€Ð°Ñ…Ð»Ð°Ð´Ð°`. Every Russian probe — i.e. almost
every probe — printed mojibake, and the parser has no test that would notice
if the `json.loads` path were traded back for a regex.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


_PROBE_PY = Path(__file__).resolve().parents[2] / "eval" / "sse_probe.py"


def _load_probe():
    assert _PROBE_PY.is_file(), (
        f"{_PROBE_PY} is gone — run_eval.py and the chat-sse-probe skill both "
        "invoke it at that path; update them and this loader together."
    )
    spec = importlib.util.spec_from_file_location("sse_probe", _PROBE_PY)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sse_probe = _load_probe()


CYRILLIC = "Прахлада Махарадж"
MOJIBAKE = CYRILLIC.encode("utf-8").decode("latin-1")


def _stream(*frames: tuple[str, dict], ensure_ascii: bool = False) -> str:
    return "".join(
        f"event: {event}\ndata: {json.dumps(data, ensure_ascii=ensure_ascii)}\n\n"
        for event, data in frames
    )


def test_mojibake_fixture_is_the_real_failure_mode() -> None:
    """Guards the guard: `MOJIBAKE` must be what the old decoder produced."""
    assert MOJIBAKE != CYRILLIC
    assert CYRILLIC.encode().decode("unicode_escape") == MOJIBAKE


def test_cyrillic_deltas_round_trip() -> None:
    raw = _stream(
        ("delta", {"text": "Прахлада "}),
        ("delta", {"text": "Махарадж"}),
    )
    answer = sse_probe.delta_text(sse_probe.iter_events(raw))

    assert answer == CYRILLIC
    assert MOJIBAKE not in answer


def test_summary_answer_is_not_mojibake() -> None:
    raw = _stream(
        ("status", {"key": "composing_answer"}),
        ("delta", {"text": CYRILLIC}),
        ("done", {"ok": True}),
    )
    summary = sse_probe.summarize(raw)

    assert summary["answer"] == CYRILLIC
    assert summary["status"] == ["composing_answer"]
    assert summary["events"] == {"status": 1, "delta": 1, "done": 1}


def test_ascii_escaped_frames_decode_too() -> None:
    """A proxy or a client that re-serialises with `ensure_ascii=True` sends
    `\\uXXXX`; `json.loads` handles both spellings, a regex handles neither."""
    raw = _stream(("delta", {"text": CYRILLIC}), ensure_ascii=True)
    assert "\\u041f" in raw

    assert sse_probe.delta_text(sse_probe.iter_events(raw)) == CYRILLIC


def test_quotes_and_newlines_inside_a_delta_survive() -> None:
    """The escapes a regex-based extractor leaves as literal backslashes."""
    text = 'он сказал: "хорошо"\nи ушёл'
    raw = _stream(("delta", {"text": text}))

    assert sse_probe.delta_text(sse_probe.iter_events(raw)) == text


def test_markers_are_found_in_the_decoded_answer() -> None:
    """Markers are extracted from the decoded text, so a Cyrillic answer must
    not hide them behind a mangled prefix."""
    raw = _stream(("delta", {"text": f"{CYRILLIC} [verse:sb_7_5_23] далее"}))
    summary = sse_probe.summarize(raw)

    assert summary["markers"] == ["[verse:sb_7_5_23]"]
    assert MOJIBAKE not in summary["answer"]


def test_malformed_delta_does_not_break_the_stream() -> None:
    """`_field` swallows a truncated frame — a dropped connection mid-event
    must not cost the deltas that did arrive."""
    raw = (
        "event: delta\ndata: {\"text\": \"Прахлада \"}\n\n"
        "event: delta\ndata: {\"text\": \"Мах\n\n"
        "event: delta\ndata: {\"text\": \"Махарадж\"}\n\n"
    )
    assert sse_probe.delta_text(sse_probe.iter_events(raw)) == CYRILLIC


@pytest.mark.parametrize(
    "event,key,expected",
    [("status", "status", ["thinking"]), ("action", "actions", ["verse"])],
)
def test_structural_fields_are_json_decoded(event: str, key: str, expected: list) -> None:
    payload = {"status": {"key": "thinking"}, "action": {"kind": "verse"}}[event]
    summary = sse_probe.summarize(_stream((event, payload)))

    assert summary[key] == expected

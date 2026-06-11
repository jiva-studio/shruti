"""JSON salvage for structured_output: models wrap valid JSON in ```json
fences / prose; we extract the first balanced object and validate it."""
from __future__ import annotations

from shruti_chat.infra.llm_provider.openrouter import _extract_json_object


def test_strips_markdown_fence():
    assert _extract_json_object('```json\n{"a": 1, "b": [2, 3]}\n```') == '{"a": 1, "b": [2, 3]}'


def test_ignores_prose_preamble_and_suffix():
    txt = 'Вот сгенерированный JSON:\n{"intro": "x"}\nНадеюсь, это поможет!'
    assert _extract_json_object(txt) == '{"intro": "x"}'


def test_braces_inside_strings_dont_fool_it():
    assert _extract_json_object('{"t": "a } b { c"}') == '{"t": "a } b { c"}'


def test_escaped_quote_inside_string():
    assert _extract_json_object('{"t": "say \\"hi\\""}') == '{"t": "say \\"hi\\""}'


def test_nested_objects_and_arrays():
    s = '{"theses": [{"t": "x", "n": [1, 2]}], "intro": "y"}'
    assert _extract_json_object('prefix ' + s + ' suffix') == s


def test_pure_prose_returns_none():
    assert _extract_json_object('Вот мой анализ кармы и экстаза.') is None


def test_empty_returns_none():
    assert _extract_json_object('') is None

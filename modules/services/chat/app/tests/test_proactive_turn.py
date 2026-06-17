"""Rule-dispatch coverage for proactive (agent-initiated) turns.

`run_proactive_turn` (application/proactive_turn.py) selects a per-rule
system prompt and synthesises the user message from `rule_context`. The
dispatch itself lives in the two pure builders it calls
(`build_system_prompt` / `build_synthetic_user_message`), so we exercise
those directly: every known `rule_kind` must produce a non-empty,
rule-appropriate prompt; `lang` must be threaded into the system prompt;
and an unknown `rule_kind` must fail loudly rather than silently emit a
generic prompt.
"""

from __future__ import annotations

import pytest

from shruti_chat.agent.proactive_prompts import (
    build_synthetic_user_message,
    build_system_prompt,
)

# The rule kinds with a dedicated prompt file in agent/proactive_prompts/.
RULE_KINDS = ["holiday", "inactivity", "weekly_digest"]

# A distinctive phrase from each rule's .md so we can prove the right
# section was layered in (not just *some* prompt).
_RULE_MARKERS = {
    "holiday": "HOLIDAY",
    "inactivity": "INACTIVITY",
    "weekly_digest": "WEEKLY DIGEST",
}


@pytest.mark.parametrize("rule_kind", RULE_KINDS)
def test_system_prompt_is_rule_appropriate(rule_kind: str) -> None:
    prompt = build_system_prompt(rule_kind, "ru")
    assert prompt.strip(), "system prompt must be non-empty"
    # The rule-specific section is layered onto the shared persona.
    assert _RULE_MARKERS[rule_kind] in prompt
    # A different rule's marker must NOT leak in — proves real dispatch.
    for other, marker in _RULE_MARKERS.items():
        if other != rule_kind:
            assert marker not in prompt


@pytest.mark.parametrize("rule_kind", RULE_KINDS)
def test_lang_is_threaded_into_system_prompt(rule_kind: str) -> None:
    for lang in ("ru", "en", "sr-Latn"):
        prompt = build_system_prompt(rule_kind, lang)
        assert f"`{lang}`" in prompt, f"lang {lang!r} not threaded through"


def test_unknown_rule_kind_fails_loudly() -> None:
    # No prompt file for an unknown rule → reading it must raise, never
    # silently fall back to a generic prompt.
    with pytest.raises(FileNotFoundError):
        build_system_prompt("does_not_exist", "ru")


@pytest.mark.parametrize("rule_kind", RULE_KINDS)
def test_synthetic_user_message_carries_context(rule_kind: str) -> None:
    ctx = {"sentinel_key": "sentinel_value", "days_away": 7}
    msg = build_synthetic_user_message(rule_kind, ctx)
    assert msg.strip(), "synthetic user message must be non-empty"
    # The rule_context is rendered verbatim as a JSON dump.
    assert "sentinel_key" in msg
    assert "sentinel_value" in msg


def test_synthetic_user_message_labels_each_known_rule() -> None:
    # Each known rule gets a rule-specific heading; an unknown rule falls
    # back to a generic label rather than crashing the JSON dump.
    labels = {
        "weekly_digest": "USER ACTIVITY THIS WEEK",
        "inactivity": "USER ACTIVITY BEFORE THE GAP",
        "holiday": "UPCOMING HOLIDAY",
    }
    for rule_kind, label in labels.items():
        assert label in build_synthetic_user_message(rule_kind, {})
    assert "RULE CONTEXT" in build_synthetic_user_message("does_not_exist", {})

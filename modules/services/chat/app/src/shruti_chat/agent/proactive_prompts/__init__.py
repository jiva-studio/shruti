"""Per-rule system prompts and synthetic-user-message builders for
proactive (agent-initiated) chat turns.

The regular `message_builder` assembles a system prompt from
`prompts/*.md` and uses real user messages as input. Proactive turns
flip both: each rule has its own short system prompt that overrides
the persona for that single turn, and the "user message" is a JSON
dump of the device-supplied `rule_context` so the LLM has the data
it needs to write the body.

Both are deliberately small — the LLM keeps full access to the same
tool registry (`list_tracks`, `chunks_search`, …) and the same
output discipline (`[action:...|id=...]` markers, citation rules).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


_PROMPT_DIR = Path(__file__).parent


def _read(name: str) -> str:
    return (_PROMPT_DIR / f"{name}.md").read_text()


def build_system_prompt(rule_kind: str, lang: str) -> str:
    """Compose the system prompt for a proactive turn.

    Always includes the shared persona/grounding/citation rules from
    `prompts/*.md` and layers a rule-specific section on top so the
    LLM knows what kind of message to write.
    """
    # Build the full system prompt fresh each call — Langfuse
    # hot-reload only works if the assembly happens per-turn (a cached
    # module-level constant would freeze the prompts at import time).
    from shruti_chat.agent.prompts import build_prompt

    full_prompt = build_prompt()
    rule_section = _read(rule_kind)
    lang_name = "Russian" if lang == "ru" else "English"
    lang_directive = (
        "\n\n"
        f"RESPONSE LANGUAGE: write the entire reply in {lang_name} ({lang}). "
        "Tool queries can be in any language that improves recall."
    )
    return full_prompt + "\n\n" + rule_section + lang_directive


def build_synthetic_user_message(rule_kind: str, rule_context: dict[str, Any]) -> str:
    """Render the rule_context as the user-side message.

    The model sees a structured JSON dump labelled with what it
    represents. Per-rule prompts tell the model how to consume it
    (e.g., "the user listened to the following last week — write a
    summary"). Plain JSON keeps the schema explicit without locking
    us into a strict wire format.
    """
    label = {
        "weekly_digest": "USER ACTIVITY THIS WEEK",
        "inactivity": "USER ACTIVITY BEFORE THE GAP",
        "holiday": "UPCOMING HOLIDAY",
    }.get(rule_kind, "RULE CONTEXT")
    return (
        f"# {label}\n\n"
        "```json\n"
        f"{json.dumps(rule_context, ensure_ascii=False, indent=2)}\n"
        "```"
    )

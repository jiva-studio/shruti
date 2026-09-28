"""Fold prior assistant turns down to user-visible transcript form.

Pure functions — no SQL, no HTTP, no streaming state. Workers/synth
in the LangGraph layer call `fold_history(history)` to strip every
chip marker / widget id / tool-protocol envelope from past assistant
turns before passing them to the LLM. The principle: feed the model
ONLY what the user actually read on screen — no integer refs, no
track ids, no source_id/tokens shapes — so it can't cargo-cult those
shapes back out on the next turn.
"""

from __future__ import annotations

import re
from typing import Any

from shruti_chat.agent.turn_aliases import TurnAliasMap


# Marker patterns stripped from prior assistant turns. Catches every
# legal chip-marker shape the server might have emitted to the client.
_CITE_FULL_RE = re.compile(
    r"\[cite:([^|@\]\s]+)@(\d+)-(\d+)(?:\|([^\]]*))?\]"
)
_CARD_FULL_RE = re.compile(r"\[card:([^\]\s]+)\]")
_OUTLINE_FULL_RE = re.compile(r"\[outline:([^\]\s]+)\]")
# Verse marker expanded form: `[verse:source_id/tokens|caption]`. source_id
# is a catalog reference id (no `/`), tokens is the verse address inside
# the book (digits, dots, commas, dashes — e.g. `2.13`, `1.2.28,1.2.29`).
_VERSE_FULL_RE = re.compile(
    r"\[verse:([^/|\]\s]+)/([^|\]\s]+)(?:\|([^\]]*))?\]"
)
# Media clip marker expanded form: `[media:<item_id>|caption]`. item_id is
# the opaque library media id; caption is free display text.
_MEDIA_FULL_RE = re.compile(r"\[media:([^|\]\s]+)(?:\|([^\]]*))?\]")

# Hallucinated tool-protocol leaks. The agent never emits `[tool_use]`
# / `[tool_result]` envelopes legitimately — they only appear when a
# weaker model invents them as fake "transcript" prose at the top of
# an assistant reply (e.g. Gemini Flash Lite, fed
# JSON-shaped research notes, copies the shape). If such a tainted
# message lands in history, feeding it back to the next turn teaches
# the model to keep doing it. Strip the entire block so the next
# `fold_history` consumer never sees the trigger.
#
# The block runs from a `[tool_use]` or `[tool_result]` opener until
# either the next prose paragraph (blank line + non-bracket text) or
# the end of the message. We're conservative: we only delete the
# leaked envelope, not the legitimate prose that may have followed.
_TOOL_PROTOCOL_LEAK_RE = re.compile(
    r"(?:^|\n)[ \t]*\[tool_(?:use|result)\][^\n]*"
    r"(?:\n(?:[ \t]*[\[\{].*|[ \t]*[\]\}].*|[ \t]+[^\n]*))*",
    re.MULTILINE,
)


def _strip_tool_protocol_leaks(content: str) -> str:
    """Remove any `[tool_use]…[tool_result]…{json…}` envelope that a
    prior assistant turn invented. See `_TOOL_PROTOCOL_LEAK_RE`."""
    return _TOOL_PROTOCOL_LEAK_RE.sub("", content).lstrip()


_FOLLOWUP_RE = re.compile(r"\[followup:[^\]\n]*\]")
_ACTION_RE = re.compile(r"\[action:[a-z][a-z0-9_]*\|id=[A-Za-z0-9_-]+\]")
# Defensive: a stray `[^N]` slipping past the expander somehow shouldn't
# show up in next-turn history either.
_FOOTNOTE_RAW_RE = re.compile(r"\[\^\d+\]")


def _fold_prior_assistant_content(
    content: str,
    aliases: TurnAliasMap | None,  # noqa: ARG001 — kept for callsite compat
) -> str:
    """Strip ALL chip / widget / tool markers from a prior assistant
    turn, leaving only pure prose.

    Principle: feed the LLM ONLY what looks like a natural-language
    transcript. No integer refs, no caption fragments, no internal
    catalog ids, no system envelopes. The LLM's grounding for the
    current turn comes from fresh research notes; the only thing it
    needs from history is the conversational thread, not the chips
    that were rendered alongside it. Caption text is dropped too: tokens
    like "духовная энергия" in the next turn's context get re-used as
    ref-slot fillers and produce hallucinations like `[^духовная энергия]`.

    Every marker shape below is DROPPED entirely (caption + body):

      `[cite:track_X@s-e|caption]`           expanded audio chip
      `[verse:source_id/tokens|caption]`     expanded verse card
      `[media:item_id|caption]`              expanded media clip card
      `[card:track_X]` / `[outline:track_X]` whole-track widgets
      `[action:kind|id=X]`                   action confirmation card
      `[followup:text]`                      followup chips outside bubble
      `[^N]`                                 stray footnote markers

    The `aliases` parameter is unused but kept on the signature so
    `fold_history` callsites don't change shape.
    """
    content = _CITE_FULL_RE.sub("", content)
    content = _VERSE_FULL_RE.sub("", content)
    content = _MEDIA_FULL_RE.sub("", content)
    content = _CARD_FULL_RE.sub("", content)
    content = _OUTLINE_FULL_RE.sub("", content)
    content = _ACTION_RE.sub("", content)
    content = _FOLLOWUP_RE.sub("", content)
    content = _FOOTNOTE_RAW_RE.sub("", content)
    # Collapse the runs of whitespace + blank lines we just opened up.
    content = re.sub(r"[ \t]+\n", "\n", content)
    content = re.sub(r"\n{3,}", "\n\n", content)
    # Trim leading whitespace per line so we don't leave " . Texto"
    # patterns (artefact of dropping a marker that sat after a comma).
    content = re.sub(r" {2,}", " ", content)
    content = re.sub(r"\s+([.,!?…:;])", r"\1", content)
    return content.strip()


def fold_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Public helper for nodes/use-cases that need history but build
    their own message lists (i.e. the LangGraph synth node, which
    composes prompt + history + internal-notes + final-question).

    Walks `history`, drops malformed entries, and strips every chip
    marker and leaked tool-protocol envelope from assistant turns (see
    `_fold_prior_assistant_content`), so a raw `track_X@...` shape can't
    seed a hallucination on the current turn. Returns a list of plain
    `{role, content}` dicts ready to splice into a Message list.
    """
    out: list[dict[str, Any]] = []
    for m in history:
        role = m.get("role")
        content = m.get("content")
        if role not in ("user", "assistant") or not content:
            continue
        if role == "assistant":
            aliases_payload = m.get("aliases")
            local_aliases: TurnAliasMap | None = None
            if isinstance(aliases_payload, dict) and aliases_payload:
                local_aliases = TurnAliasMap()
                local_aliases.load_external(aliases_payload)
            content = _fold_prior_assistant_content(content, local_aliases)
            # Defensive: drop any `[tool_use]/[tool_result]` envelopes
            # a tainted past turn may have leaked. Feeding them back
            # reinforces the mimicry on every subsequent turn.
            content = _strip_tool_protocol_leaks(content)
            if not content:
                continue
        out.append({"role": role, "content": content})
    return out

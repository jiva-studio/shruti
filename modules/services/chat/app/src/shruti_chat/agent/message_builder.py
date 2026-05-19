"""Build the LLM messages list from chat history + UserContext.

Pure functions — no SQL, no HTTP, no streaming state. Given a history
+ language + optional user context, produces the `[{role, content},
...]` array LiteLLM consumes.

The language directive forces the assistant to reply in the user's
interface language even when the model's natural inclination would be
to switch. The user-context directive surfaces the small temporal
anchors (`now`, `current_track_id`, `focus`) so the LLM can resolve
"вчера / this lecture" without a tool call.
"""

from __future__ import annotations

import re
from typing import Any

from shruti_chat.agent.prompts import SYSTEM_PROMPT
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain import UserContext


# Marker patterns we know how to either fold-back into numbered refs
# (when the corresponding alias map is available) or strip down to a
# placeholder (when it isn't). Catches every legal chip-marker shape
# the server might have emitted to the client in a prior turn.
_CITE_FULL_RE = re.compile(
    r"\[cite:([^|@\]\s]+)@(\d+)-(\d+)(?:\|([^\]]*))?\]"
)
_CARD_FULL_RE = re.compile(r"\[card:([^\]\s]+)\]")
_OUTLINE_FULL_RE = re.compile(r"\[outline:([^\]\s]+)\]")


def _fold_prior_assistant_content(
    content: str,
    aliases: TurnAliasMap | None,
) -> str:
    """Rewrite chip markers in a prior assistant message back into the
    numbered-ref format the LLM expects throughout history.

    With `aliases` present (the per-turn alias map the server emitted
    after the message was generated and the client persisted): each
    `[cite:track_X@start-end|caption]` whose `(track_X, start, end)`
    is in `aliases` becomes `[cite:N|caption]`. `[card:track_X]` /
    `[outline:track_X]` become `[card:N]` / `[outline:N]` if track_X
    has any alias in the map. Markers that aren't in the alias map
    (orphans, content drift) fall through to the same placeholder
    path as legacy messages.

    With `aliases=None` (legacy assistant message persisted before
    this protocol existed): every chip marker is collapsed to a
    placeholder that preserves only the caption — the model sees
    "I cited here" without a concrete catalog id to imitate, and the
    poison can't seed a new hallucination."""

    def _cite_sub(m: re.Match[str]) -> str:
        track_id, start_str, end_str = m.group(1), m.group(2), m.group(3)
        caption = (m.group(4) or "").strip()
        if aliases is not None:
            n = aliases.lookup_ref(track_id, int(start_str), int(end_str))
            if n is not None:
                return f"[cite:{n}|{caption}]" if caption else f"[cite:{n}]"
        # No alias — fall back to placeholder so the format isn't a
        # `track_X@...` pattern the model could imitate.
        return f"[cite:…|{caption}]" if caption else "[cite:…]"

    def _whole_track_sub(prefix: str) -> "callable":
        def _sub(m: re.Match[str]) -> str:
            track_id = m.group(1)
            if aliases is not None:
                # Track-level (card/outline) alias has start_ms/end_ms = None.
                n = aliases.lookup_ref(track_id, None, None)
                if n is not None:
                    return f"[{prefix}:{n}]"
            return f"[{prefix}:…]"
        return _sub

    content = _CITE_FULL_RE.sub(_cite_sub, content)
    content = _CARD_FULL_RE.sub(_whole_track_sub("card"), content)
    content = _OUTLINE_FULL_RE.sub(_whole_track_sub("outline"), content)
    return content


_LANG_NAME = {"ru": "Russian", "en": "English"}
_LANG_EXAMPLE = {
    "ru": (
        "User: «Дай список лекций про политику»\n"
        "WRONG (in English): \"The search for 'politics' yields...\"\n"
        "RIGHT (in Russian): «Вот несколько лекций о политике:» followed by [card:...] markers."
    ),
    "en": (
        "User: \"Give me lectures on politics\"\n"
        "WRONG (in Russian): «Поиск по слову 'политика' дал...»\n"
        "RIGHT (in English): \"Here are some lectures on politics:\" followed by [card:...] markers."
    ),
}


def build_messages(
    history: list[dict[str, Any]],
    lang: str,
    user_context: UserContext | None = None,
) -> list[dict[str, Any]]:
    """Build the LLM messages list.

    For each prior assistant turn, the input dict may carry an
    optional `aliases` field — the integer→chunk map the server
    emitted while answering that turn (the client persisted it and
    shipped it back). If present, chip markers in the assistant
    content are folded back into `[cite:N|caption]` form so the LLM
    sees one consistent numbered-ref format across the whole history.
    If absent (legacy assistant message), the markers are collapsed
    to placeholders so a `track_X@...` pattern can't seed a new
    hallucination.
    """
    lang_name = _LANG_NAME.get(lang, lang)
    lang_directive = (
        "\n\n"
        "═══════════════════════════════════════════════════════════════════════\n"
        f"RESPONSE LANGUAGE — STRICT — REPLY ONLY IN {lang_name.upper()}\n"
        "═══════════════════════════════════════════════════════════════════════\n"
        f"\nThe user's interface language is {lang_name} ({lang}). EVERY sentence "
        f"of your reply prose MUST be written in {lang_name}. Do not switch "
        "languages mid-response. Do not narrate in English what you'll do "
        f"if the user wrote in {lang_name}. Tool search queries may be in any "
        f"language that improves recall, but your visible reply text is "
        f"{lang_name}-only.\n\n"
        f"{_LANG_EXAMPLE.get(lang, '')}\n"
    )
    ctx_directive = _format_user_context(user_context)
    sys = {"role": "system", "content": SYSTEM_PROMPT + lang_directive + ctx_directive}
    clean: list[dict[str, Any]] = []
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
            if not content:
                continue
        clean.append({"role": role, "content": content})
    return [sys, *clean]


def _format_user_context(uc: UserContext | None) -> str:
    """Render the small temporal anchors into the system prompt.

    Big lists (recent_tracks/notes) stay accessible only via personalize
    tools — pasting them into the prompt would explode the token bill on
    every turn. But `now` and `current_track_id` are tiny and load-bearing
    for relative-time and "this lecture" phrases — those go inline.
    """
    if uc is None:
        return ""
    lines: list[str] = []
    if uc.now is not None:
        lines.append(f"now: {uc.now.isoformat()}")
    if uc.current_track_id:
        lines.append(f"current_track_id: {uc.current_track_id}")
    if uc.focus is not None:
        ftitle = uc.focus.title or ""
        lines.append(
            f"focus: track_id={uc.focus.track_id} "
            f"start_ms={uc.focus.start_ms} "
            f"end_ms={uc.focus.end_ms} "
            f"title={ftitle!r}"
        )
    in_progress_n = len(uc.in_progress_tracks())
    lines.append(
        f"history_size: recent={len(uc.recent_tracks)} "
        f"in_progress={in_progress_n}"
    )
    if not lines:
        return ""
    return (
        "\n\n"
        "═══════════════════════════════════════════════════════════════════════\n"
        "USER CONTEXT (anchors for relative-time and 'this lecture' phrases)\n"
        "═══════════════════════════════════════════════════════════════════════\n\n"
        + "\n".join(lines)
        + "\n\n"
        "Use `now` to compute `since` / `until` bounds for `list_my_tracks`\n"
        "when the user asks «вчера / на этой неделе / a week ago». Pass\n"
        "ISO-8601 strings with the same offset as `now`.\n\n"
        "When the user says «эту / текущую / только что слушал / this / current»\n"
        "lecture OR doesn't name any lecture — and `current_track_id` is set —\n"
        "use it directly as the track_id for `get_track_outline` /\n"
        "`get_transcript_window` etc. NEVER outline a random track when the\n"
        "user means 'this one' — that's the worst kind of hallucination here.\n"
        "If `current_track_id` is NOT set and the user didn't name a track,\n"
        "ask which lecture they mean instead of guessing.\n\n"
        "If `focus` is set, the user has tapped a specific span (an outline\n"
        "chapter or a citation) and the request implicitly targets it.\n"
        "Always start with `get_transcript_window(track_id=focus.track_id,\n"
        "around_ms=(focus.start_ms + focus.end_ms)/2,\n"
        "window_seconds=ceil((focus.end_ms - focus.start_ms) / 1000) + 30)`\n"
        "and base your retelling on those chunks. Cite individual lines\n"
        "with [cite:track_id@start_ms-end_ms|caption]. Do NOT call\n"
        "get_track_outline — the user already saw it.\n"
    )

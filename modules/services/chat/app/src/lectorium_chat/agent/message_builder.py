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

from lectorium_chat.agent.prompts import SYSTEM_PROMPT
from lectorium_chat.domain import UserContext


# ── History compaction ──────────────────────────────────────────────────
#
# When a multi-turn conversation comes back as history on turn N+1, the
# prior assistant messages still carry the inline chip / followup
# markers the renderer needs. Sending them verbatim to the LLM:
#   1. Wastes tokens — `[cite:track_OkPVGYhR5PPu@630560-684400|caption]`
#      is ~60 chars; a reply with 10 citations adds ~600 chars to every
#      subsequent turn.
#   2. Primes hallucination — the model sees its own previous prose
#      with `[cite:track_…]` patterns and starts inventing new ids by
#      analogy. Empirically: Gemini Flash Lite's track-id fabrications
#      in long sessions (the "Что такое бхакти" case) cluster on
#      turns 3+, after the marker pattern is well-established in
#      context.
#
# We strip chip-class markers (cite/card/outline/followup) from prior
# assistant prose before sending to the LLM. The chip text — the
# caption — is preserved for cite so the surrounding sentence still
# reads naturally ("Прабхупада говорит, что бхакти — это «совершенство
# жизни» — это путь служения").
#
# Action markers (`[action:create_playlist|id=…]`) STAY — the model
# needs to remember it proposed an action in a prior turn.
#
# This is server-side only and doesn't affect what's stored or
# rendered for the user — the client keeps the full marker text.

_CITE_RE = re.compile(r"\[cite:[A-Za-z0-9_.-]+@\d+-\d+(?:\|([^\]]*))?\]")
_CARD_RE = re.compile(r"\[card:[A-Za-z0-9_.-]+\]")
_OUTLINE_RE = re.compile(r"\[outline:[A-Za-z0-9_.-]+\]")
_FOLLOWUP_RE = re.compile(r"\[followup:[^\]\n|]+\]")
_WS_COLLAPSE = re.compile(r"[ \t]{2,}")


def _strip_chip_markers(content: str) -> str:
    """Drop chip / followup markers from a prior assistant message.

    `[cite:track@start-end|caption]` → `«caption»` (keep the semantic
    label so the sentence still parses), `[cite:track@start-end]` (no
    caption) → empty.
    `[card:…]`, `[outline:…]`, `[followup:…]` → empty.
    `[action:…|id=…]` markers are left untouched.
    """
    def _cite_sub(m: re.Match[str]) -> str:
        caption = (m.group(1) or "").strip()
        return f"«{caption}»" if caption else ""

    out = _CITE_RE.sub(_cite_sub, content)
    out = _CARD_RE.sub("", out)
    out = _OUTLINE_RE.sub("", out)
    out = _FOLLOWUP_RE.sub("", out)
    # Tidy double-spaces left by deletions; preserve newlines.
    out = _WS_COLLAPSE.sub(" ", out)
    return out.strip()


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
    # Strip any non-standard fields from history (defensive). For prior
    # assistant turns, also strip chip-class markers so the model's
    # context doesn't get polluted with marker patterns to imitate (the
    # source of the turn-2+ id-fabrication regression on weaker models).
    clean: list[dict[str, Any]] = []
    for m in history:
        role = m.get("role")
        content = m.get("content")
        if role not in ("user", "assistant") or not content:
            continue
        if role == "assistant":
            content = _strip_chip_markers(content)
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

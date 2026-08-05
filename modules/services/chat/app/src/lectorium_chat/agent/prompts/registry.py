"""The prompt registry — one table, three consumers.

Every prompt this service uses is a pair: a Langfuse prompt name and the
bundled `.md` that serves as its fallback (Langfuse unreachable,
`LANGFUSE_FORCE_FALLBACK=1`, eval runs). That pairing lived in three places
that had drifted apart:

  - `_PROMPTS` in `scripts/bootstrap_langfuse_prompts.py` — what gets
    published: 23 entries.
  - `LANGFUSE_PROMPT_NAMES` — what gets warmed at boot: 17, one of which
    (`chat-section-library`) had been renamed away and logged a warm-up miss
    on every start.
  - the call sites — what actually gets fetched: 28.

The five in neither published list were fetched anyway, so each one 404'd,
logged `langfuse_get_prompt_failed`, and fell back. There is no negative cache
on that path, so `lecture-authors` — which runs alongside the router on EVERY
message — paid a failed round-trip per message, forever.

The `.md` files are the ground truth for what CAN be fetched: every fetch
supplies one as its fallback. So this table must be a bijection with them,
which `tests/test_prompt_registry.py` pins.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


PROMPT_DIR = Path(__file__).parent

# Models referenced by the publishing config. These are what the prompt is
# published WITH in the Langfuse UI; the runtime model comes from Settings.
_DEFAULT_LLM = "openrouter/deepseek/deepseek-chat"
_OUTLINE_LLM = "openrouter/google/gemini-2.5-flash-lite"
_FLASH_LITE = "openrouter/google/gemini-3.1-flash-lite"
_FLASH = "openrouter/google/gemini-2.5-flash"


@dataclass(frozen=True)
class PromptSpec:
    """One prompt: its Langfuse name, its bundled fallback, and how it is
    published. `config` and `tags` are publishing metadata — the bootstrap
    script's business; nothing at runtime reads them."""

    name: str
    md: str
    config: dict = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)

    @property
    def path(self) -> Path:
        return PROMPT_DIR / f"{self.md}.md"


PROMPTS: tuple[PromptSpec, ...] = (
    PromptSpec("query-planner", "query_planner", {"model": _FLASH_LITE, "note": 'structured_output → temperature forced to 0', "temperature": 0}, ['chat', 'research']),
    PromptSpec("synthesis-planner", "synthesis_planner", {"model": _FLASH, "note": 'structured_output → temperature forced to 0; uses full Flash (not Lite) — attribution selection over 15-25 notes', "schema": 'Outline', "temperature": 0}, ['chat', 'synth']),
    PromptSpec("conclusion-writer", "conclusion_writer", {"model": _FLASH_LITE, "note": 'structured_output → temperature forced to 0; fallback for outlines with 3+ theses where synthesis-planner left conclusion null', "schema": 'ConclusionResponse', "temperature": 0}, ['chat', 'synth']),
    PromptSpec("intro-writer", "intro_writer", {"model": _FLASH_LITE, "note": 'structured_output → temperature forced to 0; rewrites the intro from finished theses (2+ theses) so it states the claims, not a topic table-of-contents', "schema": 'IntroResponse', "temperature": 0}, ['chat', 'synth']),
    PromptSpec("topic-extractor", "topic_extractor", {"model": _FLASH_LITE, "note": 'structured_output → temperature forced to 0', "temperature": 0}, ['chat', 'research']),
    PromptSpec("caption-generator", "caption_generator", {"model": _FLASH_LITE, "note": 'structured_output → temperature forced to 0', "temperature": 0}, ['chat', 'research']),
    PromptSpec("chat-router", "router", {"model": _FLASH_LITE, "note": 'structured_output → temperature forced to 0', "schema": 'RoutingDecision', "temperature": 0}, ['chat', 'router']),
    PromptSpec("reply-language", "reply_language", {"model": _FLASH_LITE, "note": 'structured_output → temperature forced to 0; one conversation ATTRIBUTE (see domain/conversation_attributes.py) — abstains (empty value) when the message carries no signal', "schema": 'Attribute', "temperature": 0}, ['chat', 'router']),
    PromptSpec("localized-reply", "localized_reply", {"model": _FLASH_LITE, "note": 'structured_output → temperature forced to 0; localises a fixed reply into EVERY shipped locale. On a parse miss the caller re-asks with this same text plus a plain-text override (kept in code — an edit here must not be able to break the schema contract)', "schema": 'LocalizedReply', "temperature": 0}, ['chat', 'worker']),
    PromptSpec("find-tracks-intro", "find_tracks_intro", {"model": _FLASH_LITE, "note": 'text_completion (no JSON envelope); the lead-in above a lecture list. When the reference filter was relaxed the caller adds the facts + an explicit ban on naming it', "temperature": 0}, ['chat', 'worker']),
    PromptSpec("find-tracks-description", "find_tracks_description", {"model": _FLASH_LITE, "note": 'text_completion (no JSON envelope); the per-card blurb, one call per lecture', "temperature": 0}, ['chat', 'worker']),
    PromptSpec("chat-section-header", "header", {}, ['chat', 'synth', 'worker']),
    PromptSpec("chat-section-tools", "tools", {}, ['chat', 'worker']),
    PromptSpec("chat-section-actions", "actions", {}, ['chat', 'synth', 'worker']),
    PromptSpec("chat-section-followups", "followups", {}, ['chat', 'synth']),
    PromptSpec("chat-section-no_narration", "no_narration", {}, ['chat', 'synth']),
    PromptSpec("chat-section-citations", "citations", {}, ['chat', 'synth']),
    PromptSpec("chat-section-note_types", "note_types", {}, ['chat', 'synth']),
    PromptSpec("chat-section-quoting", "quoting", {}, ['chat', 'synth', 'worker']),
    PromptSpec("chat-section-response_shape", "response_shape", {}, ['chat', 'synth']),
    PromptSpec("chat-section-language", "language", {}, ['chat', 'synth']),
    PromptSpec("chat-section-safety", "safety", {}, ['chat', 'synth']),
    PromptSpec("chat-section-grounding", "grounding", {}, ['chat', 'synth']),
    PromptSpec("chat-followup-rewrite", "followup_rewrite", {"model": _FLASH_LITE, "temperature": 0, "note": 'structured_output → temperature forced to 0; rewrites a follow-up into a standalone query'}, ['chat', 'research']),
    PromptSpec("lecture-authors", "lecture_authors", {"model": _FLASH_LITE, "temperature": 0, "note": 'structured_output → temperature forced to 0; runs on EVERY message alongside the router'}, ['chat', 'attributes']),
    PromptSpec("chat-section-fallback", "fallback", {}, ['chat', 'synth']),
    PromptSpec("chat-section-out_of_scope", "out_of_scope", {}, ['chat', 'synth']),
    PromptSpec("chat-section-show_verse", "show_verse", {}, ['chat', 'synth']),)


# Warmed at startup so the first turn after a deploy doesn't pay a network
# round-trip per prompt on the hot path.
LANGFUSE_PROMPT_NAMES: tuple[str, ...] = tuple(p.name for p in PROMPTS)

_BY_NAME = {p.name: p for p in PROMPTS}


def spec_for(name: str) -> PromptSpec | None:
    """The registry entry for a Langfuse prompt name, or None if unregistered."""
    return _BY_NAME.get(name)

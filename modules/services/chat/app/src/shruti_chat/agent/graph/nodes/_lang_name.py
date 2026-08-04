"""Human name of the answer language, for the `{{LANG_NAME}}` directive.

A bare locale code in that directive makes the model drift (it answered
Russian to `sr-Latn`), so both prose-composing hops — the synthesizer and the
planner-side writers — need the language's own name. They resolved it
identically; this is that one lookup.

The catalog `languages` table stays the source of truth for every locale the
app ships (it auto-extends, so nothing here needs per-language maintenance).
`ctx.lang_name` covers what the table cannot: the reply language is an open
set — an Italian question gets an Italian answer — and the detector that
settled it hands back the name along with the code.
"""

from __future__ import annotations

from shruti_chat.agent.graph.turn_context import TurnContext


async def resolve_lang_name(ctx: TurnContext, code: str) -> str | None:
    """Native name for `code`, or None to let the prompt fall back to the
    code. Never raises — a language hint must not fail the turn."""
    if ctx.catalog_repo is not None:
        try:
            name = await ctx.catalog_repo.language_name(code)
        except Exception:  # noqa: BLE001
            name = None
        if name:
            return name
    return ctx.lang_name or None

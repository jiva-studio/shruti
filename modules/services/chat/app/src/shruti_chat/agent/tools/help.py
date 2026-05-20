"""get_help — read the bundled help corpus (modules/docs/help)."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from shruti_chat.agent.tools._registry import ToolDef, register_tool

log = logging.getLogger(__name__)

_DEFAULT_CORPUS_DIR = Path("/app/docs/help")
_CORPUS_DIR = Path(os.environ.get("HELP_CORPUS_DIR", str(_DEFAULT_CORPUS_DIR)))


def _read_pages(locale: str) -> dict[str, str]:
    suffix = f".{locale}.md"
    out: dict[str, str] = {}
    if not _CORPUS_DIR.is_dir():
        log.warning("help corpus dir missing: %s", _CORPUS_DIR)
        return out
    for path in sorted(_CORPUS_DIR.glob(f"*{suffix}")):
        page_id = path.name[: -len(suffix)]
        out[page_id] = path.read_text(encoding="utf-8")
    return out


async def get_help(locale: str = "en") -> str:
    """Concatenate every help page for ``locale``; fall back to English."""
    if locale not in ("en", "ru"):
        locale = "en"
    pages = _read_pages(locale)
    if not pages and locale != "en":
        pages = _read_pages("en")
    if not pages:
        return "(help corpus not available)"
    return "\n\n".join(
        f"# {page_id}\n\n{body.strip()}" for page_id, body in pages.items()
    )


register_tool(ToolDef(
    name="help_get",
    fn=get_help,
    description=(
        "Return the in-app help wiki for the user's locale. Use when the "
        "user asks how the APP works — settings, region switching, "
        "indicators, downloads, export/import, what a feature does, where "
        "to find something. Do NOT use for questions about lecture "
        "content (use chunks_search instead). The full corpus is "
        "returned in one call; pick the relevant section for the answer."
    ),
    parameters={
        "type": "object",
        "properties": {
            "locale": {
                "type": "string",
                "enum": ["en", "ru"],
                "description": "Locale of the help text. Defaults to 'en'.",
            },
        },
    },
))

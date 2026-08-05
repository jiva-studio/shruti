"""get_help — read the bundled help corpus (modules/docs/help)."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from lectorium_chat.agent.tools._registry import ToolDef, register_tool

log = logging.getLogger(__name__)

def _corpus_dir() -> Path:
    """Resolved per call rather than at import: read at import time this was
    unswappable per-instance and invisible to `Settings`."""
    from lectorium_chat.config import get_settings

    return get_settings().help_corpus_dir


def _read_pages(locale: str) -> dict[str, str]:
    suffix = f".{locale}.md"
    out: dict[str, str] = {}
    corpus_dir = _corpus_dir()
    if not corpus_dir.is_dir():
        log.warning("help corpus dir missing: %s", corpus_dir)
        return out
    for path in sorted(corpus_dir.glob(f"*{suffix}")):
        page_id = path.name[: -len(suffix)]
        out[page_id] = path.read_text(encoding="utf-8")
    return out


async def get_help(locale: str = "en") -> str:
    """Concatenate every help page for ``locale``; fall back to English.

    Any locale the corpus has been translated into is served as-is — the
    available set is decided from the files on disk (``*.<locale>.md``),
    not a hardcoded list — so a locale falls back to English only when no
    page exists for it yet.
    """
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
                "enum": [
                    "en", "ru", "uk", "sr-Latn", "sr-Cyrl", "es", "pt",
                    "it", "de", "fr", "pl", "hu", "hi", "bn",
                ],
                "description": (
                    "Locale of the help text. Defaults to 'en'. Any "
                    "untranslated locale falls back to English."
                ),
            },
        },
    },
))

"""Shared helpers across chunks_* / user_* tools."""

from __future__ import annotations

from datetime import datetime, tzinfo
from typing import Any

from shruti_chat.domain.user_context import as_aware


_NO_CTX_HINT = (
    "Контекст пользователя не передан. Скажи пользователю, что нужно "
    "сначала послушать или сохранить заметки, чтобы я мог опираться на историю."
)


# Canonical book-code → addr_label prefix per language. Used by
# `chunks_get_by_address` to compose the addr_label key. Values match
# the prefixes the indexer writes into `chunks.addr_label`.
BOOK_PREFIX: dict[str, dict[str, str]] = {
    "BG":        {"ru": "БГ",        "en": "BG"},
    "SB":        {"ru": "ШБ",        "en": "SB"},
    "CC Adi":    {"ru": "ЧЧ Ади",    "en": "CC Adi"},
    "CC Madhya": {"ru": "ЧЧ Мадхйа", "en": "CC Madhya"},
    "CC Antya":  {"ru": "ЧЧ Антйа",  "en": "CC Antya"},
    "BS":        {"ru": "БС",        "en": "BS"},
    "ISO":       {"ru": "ИШО",       "en": "ISO"},
    "NoI":       {"ru": "НН",        "en": "NoI"},
    "MM":        {"ru": "ММC",       "en": "MM"},
    "NBS":       {"ru": "НБС",       "en": "NBS"},
}


def ok_or_no_ctx(items: list, has_ctx: bool) -> dict[str, Any] | list:
    """Return items if user_context is present, else a structured error."""
    if not has_ctx:
        return {"error": "user_context_missing", "hint": _NO_CTX_HINT}
    return items


def parse_iso(
    value: str | None, *, field: str, tz: tzinfo | None = None,
) -> datetime | None:
    """Parse an LLM-written bound, always tz-aware.

    The tool schemas ask for the same offset as `user_context.now` but
    nothing enforces one, and models routinely emit a bare date. Pass
    the user's `tz` so an offset-less bound is read as device-local —
    it is what the model meant, and the alternative (UTC) silently
    slides the window by the user's offset: at UTC+5, «this week»
    starting Monday 00:00 would drop everything played before 05:00.
    """
    if value is None or value == "":
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be ISO-8601 (got {value!r})") from exc
    return as_aware(dt, tz)

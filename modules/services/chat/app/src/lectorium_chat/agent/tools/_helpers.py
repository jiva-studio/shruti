"""Shared helpers across chunks_* / user_* tools."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from lectorium_chat.domain.user_context import as_aware


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


def parse_iso(value: str | None, *, field: str) -> datetime | None:
    """Parse an LLM-written bound, always tz-aware.

    The tool schemas ask for an offset but nothing enforces one, and
    models routinely emit a bare date. An offset-less value is read as
    UTC so it can be compared with `last_played_at`.
    """
    if value is None or value == "":
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be ISO-8601 (got {value!r})") from exc
    return as_aware(dt)

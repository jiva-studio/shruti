"""Sanskrit text helpers for the chat service.

Currently: deterministic IAST → Russian (Cyrillic) transliteration of
verse `transliteration` fields, generated from the clean Latin IAST that
is the source of truth in `library.db`. See `transliteration.py`.
"""

from shruti_chat.sanskrit.transliteration import iast_to_cyrillic

__all__ = ["iast_to_cyrillic"]

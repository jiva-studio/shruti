"""Sanskrit text helpers for the chat service.

Deterministic IAST → target-script transliteration of verse
`transliteration` fields, generated from the clean Latin IAST that is the
source of truth in `library.db`. One transliterator per target language
(`iast_to_ru` / `iast_to_uk` / `iast_to_sr`); `sr-Latn` is the IAST itself.
`sr_latin_to_cyrillic` converts non-Sanskrit Serbian prose between scripts.
See `transliteration.py`.
"""

from lectorium_chat.sanskrit.transliteration import (
    iast_to_ru,
    iast_to_sr,
    iast_to_uk,
    sr_latin_to_cyrillic,
)

__all__ = ["iast_to_ru", "iast_to_uk", "iast_to_sr", "sr_latin_to_cyrillic"]

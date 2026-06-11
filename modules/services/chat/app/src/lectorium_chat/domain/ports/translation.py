"""TranslationService — port for opt-in citation translation.

The chat service ships verbatim corpus prose (transcript snippets, verse
translations, commentary, media text) to the client. When the answer
language has no native variant and the user opted in
(`translate_citations`), this service LLM-translates the source prose into
the answer language. Translations are persistent-cached (one translation
per source text for ALL users) so the live LLM call is paid at most once
per (source, language, model, prompt) tuple.

Sanskrit / IAST is NEVER routed here — transliteration is a deterministic
script conversion (see `sanskrit/`), not a translation.
"""

from __future__ import annotations

from typing import Protocol


class TranslationService(Protocol):
    async def translate(self, text: str, *, src_lang: str, tgt_lang: str) -> str:
        """Translate `text` from `src_lang` into `tgt_lang`, preserving the
        meaning of scripture verbatim (no embellishment, no commentary).
        Returns the translated string. On any failure the implementation
        falls back to returning the source `text` unchanged — a citation
        never fails the turn.
        """
        ...

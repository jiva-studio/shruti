"""LLM-backed `TranslationService` with a two-tier persistent cache.

Read order: Redis hot cache → Postgres persistent cache → live LLM call.
On a live miss the result is written through to BOTH tiers, so the next
turn (any user) is served from cache. The model is part of the cache key,
so a model swap mints fresh translations and leaves old ones to age out.

Serbian economy: both Serbian scripts share ONE cache row. We normalise
the cache `language` to `sr-Latn`, translate into Serbian Latin, store
that, and derive `sr-Cyrl` by deterministic transliteration on output.
Generating Latin once and transliterating is both higher-quality (models
are steadier on Latin) and cheaper (one row serves both scripts).

Sanskrit / IAST never reaches here — that's a deterministic script
conversion in `sanskrit/`, not a translation.
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
from typing import Any

from shruti_chat.application.cache_helpers import TTL_30D, cached_str
from shruti_chat.domain.entities import Message
from shruti_chat.infra.translation.pg_translation_cache import PgTranslationCache
from shruti_chat.sanskrit import iast_to_sr, sr_latin_to_cyrillic
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


# A "word" run vs a non-word run (whitespace / punctuation), preserving both
# so the rebuilt string keeps the original spacing.
_WORD_SPLIT_RE = re.compile(r"(\W+)", flags=re.UNICODE)


def _has_iast_diacritic(token: str) -> bool:
    """True when a Latin token carries a Sanskrit IAST diacritic (macron,
    dot-below, dot-above, acute on s, tilde on n). These are the marks the
    translator system-prompt preserves verbatim (Kṛṣṇa, gītā, Prabhupāda),
    and which `sr_latin_to_cyrillic` would leave half-converted."""
    for ch in unicodedata.normalize("NFD", token):
        # COMBINING MACRON / DOT BELOW / DOT ABOVE / ACUTE / TILDE — the
        # decomposed forms of every IAST diacritic used in the corpus.
        if ch in ("̄", "̣", "̇", "́", "̃"):
            return True
    return False


def serbian_text_to_cyrillic(text: str) -> str:
    """Convert Serbian-Latin prose to Cyrillic while keeping IAST Sanskrit
    tokens in their correct Serbian-Cyrillic transliteration.

    The translator deliberately preserves IAST names (Kṛṣṇa, Bhagavad-gītā,
    Prabhupāda) inside the Serbian-Latin output. Running the plain Gajica
    `sr_latin_to_cyrillic` over the WHOLE string produces hybrid garbage
    (`Kṛṣṇa → Кṛṣṇа`) because it maps base Latin letters but passes the
    diacritics through. So we tokenise: IAST tokens go through `iast_to_sr`
    (a proper IAST→Serbian-Cyrillic map), the surrounding Serbian-Latin
    prose through `sr_latin_to_cyrillic`. Non-word runs (spaces,
    punctuation) are preserved verbatim. Mirrors the ru-side hybrid fix.
    """
    if not text:
        return text
    out: list[str] = []
    for part in _WORD_SPLIT_RE.split(text):
        if not part:
            continue
        if _has_iast_diacritic(part):
            out.append(iast_to_sr(part))
        else:
            out.append(sr_latin_to_cyrillic(part))
    return "".join(out)


# Bump when the system prompt below changes so old cached rows (keyed on
# this version) are bypassed and re-warmed with the new instructions.
PROMPT_VERSION = "v1"

_SYSTEM_PROMPT = (
    "You are a precise translator of Vaiṣṇava scripture-related prose. "
    "Translate the user's text into the target language LITERALLY, "
    "preserving the exact meaning. Do NOT add, omit, explain, or "
    "embellish anything. Keep Sanskrit terms, names, and any IAST "
    "diacritic words EXACTLY as written — never translate or transliterate "
    "them. Output ONLY the translation, with no preface, quotes, or notes."
)


def _normalise_target(tgt_lang: str) -> tuple[str, bool]:
    """Map the request locale to the cache language + whether the result
    must be transliterated Latin→Cyrillic on output.

    Both Serbian scripts share the `sr-Latn` row; `sr-Cyrl` is derived by
    transliteration. Every other locale is its own cache language.
    """
    if tgt_lang == "sr-Cyrl":
        return "sr-Latn", True
    return tgt_lang, False


class LlmTranslationService:
    def __init__(
        self,
        *,
        llm: Any,                       # LLMPort
        model: str,                     # settings.llm_translate
        pg_cache: PgTranslationCache,
        kv_cache: Any | None = None,    # KVCache (Redis hot tier)
        max_concurrency: int = 6,
        max_retries: int = 2,
    ) -> None:
        self._llm = llm
        self._model = model
        self._pg = pg_cache
        self._kv = kv_cache
        self._max_concurrency = max_concurrency
        self._max_retries = max_retries
        self._sem: asyncio.Semaphore | None = None

    def _semaphore(self) -> asyncio.Semaphore:
        # Lazy so the Semaphore binds to the running loop, not import time.
        if self._sem is None:
            self._sem = asyncio.Semaphore(self._max_concurrency)
        return self._sem

    async def translate(self, text: str, *, src_lang: str, tgt_lang: str) -> str:
        src = (text or "").strip()
        if not src:
            return text
        cache_lang, to_cyrillic = _normalise_target(tgt_lang)
        # Same-language no-op (e.g. translate_citations on with a native
        # source) — never round-trip through the LLM. For a `sr-Latn` source
        # requested as `sr-Cyrl` we must STILL transliterate Latin→Cyrillic
        # (the cache langs match but the scripts don't), else a Cyrillic
        # user gets handed Latin.
        if cache_lang == src_lang:
            return serbian_text_to_cyrillic(text) if to_cyrillic else text

        translated = await self._translate_into(src, cache_lang)
        return serbian_text_to_cyrillic(translated) if to_cyrillic else translated

    async def _translate_into(self, src: str, cache_lang: str) -> str:
        """Resolve the Latin-script translation for `cache_lang`, going
        Redis → Postgres → live LLM with write-through to both tiers."""
        # Tier 1: Redis hot cache (cached_str does its own miss → factory).
        if self._kv is not None:
            return await cached_str(
                self._kv,
                ns="translated_chunk",
                key_parts={
                    # `make_key` blake2b-hashes the canonical key, so passing
                    # the full source text here is fine — it never lands in
                    # the Redis key verbatim.
                    "src": src,
                    "lang": cache_lang,
                    "model": self._model,
                    "pv": PROMPT_VERSION,
                },
                ttl_s=TTL_30D,
                factory=lambda: self._pg_then_llm(src, cache_lang),
            )
        return await self._pg_then_llm(src, cache_lang)

    async def _pg_then_llm(self, src: str, cache_lang: str) -> str:
        """Tier 2 + 3: Postgres persistent cache → live LLM (write-through)."""
        try:
            hit = await self._pg.get(
                source_text=src, language=cache_lang,
                model=self._model, prompt_version=PROMPT_VERSION,
            )
        except Exception as exc:  # noqa: BLE001 — cache read never fails a turn
            log.warning("translation_pg_read_failed", error=str(exc))
            hit = None
        if hit is not None:
            return hit

        # Cap how many live translations hit OpenRouter at once — a research
        # turn can mint 30+ citations, and firing them all in parallel trips
        # provider rate limits, which surfaced as untranslated citations.
        async with self._semaphore():
            out = await self._llm_translate(src, cache_lang)
        try:
            await self._pg.put(
                source_text=src, language=cache_lang,
                model=self._model, prompt_version=PROMPT_VERSION,
                translated_text=out,
            )
        except Exception as exc:  # noqa: BLE001 — write-through is best-effort
            log.warning("translation_pg_write_failed", error=str(exc))
        return out

    async def _llm_translate(self, src: str, cache_lang: str) -> str:
        messages: list[Message] = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Target language code: {cache_lang}\n\n"
                    f"Text to translate:\n{src}"
                ),
            },
        ]
        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                parts: list[str] = []
                async for chunk in self._llm.stream_completion(
                    messages, model=self._model, temperature=0.0,
                    run_name="citation_translate",
                ):
                    t = chunk.get("text")
                    if t:
                        parts.append(t)
                out = "".join(parts).strip()
                if out:
                    return out
            except Exception as exc:  # noqa: BLE001 — never fail a turn on translation
                last_exc = exc
            if attempt < self._max_retries:
                await asyncio.sleep(0.5 * (2 ** attempt))
        log.warning(
            "translation_llm_failed",
            error=str(last_exc) if last_exc else "empty_output", lang=cache_lang,
        )
        return src

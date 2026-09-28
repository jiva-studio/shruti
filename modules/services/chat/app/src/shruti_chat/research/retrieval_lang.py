"""Which corpus language a turn retrieves in.

Retrieval is single-language and index-bound, while the answer can be in any
locale the client speaks; these helpers clamp the answer language onto a
language the corpus actually carries.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from shruti_chat.domain.language import base_tag
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


# Fallback retrieval language when the answer language has no corpus AND
# a genuine empty-corpus RESULT came back. English is the product's
# guaranteed-present corpus language and always has a partial HNSW index.
_DEFAULT_RETRIEVAL_LANG = "en"

# Static corpus-language set used ONLY when the `distinct_langs` probe
# RAISES (transient Postgres/Redis hiccup) — as opposed to returning an
# empty list. A bare clamp against [] would force English even for a
# Russian turn, silently degrading a ru question to English-only grounding
# on a transient blip. The product's guaranteed corpus languages are en+ru
# (see `Settings.indexer_langs` default "ru,en"); the configured set wins
# when there is one, this literal otherwise.
_PROBE_FAILURE_FALLBACK_LANGS = ("en", "ru")

# Locale → content-language reduction map. The Python mirror of the client
# policy in modules/libs/domain/services/contentLanguage.ts. The UI ships in
# many locales but the corpus carries only a few content languages (en,
# ru); this map sends each supported UI locale's base subtag to the content
# language it reads in. To extend, add a row (a new East-Slavic UI locale →
# "ru", or a brand-new corpus language → itself) and mirror it on the TS side
# so chat, proactive prompts and the website agree. Any locale not in the map
# falls back to `_DEFAULT_CONTENT_LANG`.
_DEFAULT_CONTENT_LANG = "en"
_LOCALE_CONTENT_LANG: dict[str, str] = {
    "en": "en",
    "ru": "ru",
    "uk": "ru",
}


def reduce_locale_to_content_lang(locale: str) -> str:
    """Base content language a UI locale reduces to, ignoring corpus
    availability — the Python twin of `reduceLocaleToContentLanguage`.
    `uk`/`uk_UA`/`ru-RU` → `ru`; `sr-Latn`/`en-US`/unknown → `en`."""
    return _LOCALE_CONTENT_LANG.get(base_tag(locale), _DEFAULT_CONTENT_LANG)


def fallback_corpus_langs(configured: Sequence[str]) -> list[str]:
    """Static corpus-language set for a probe FAILURE: the deployment's
    configured `indexer_langs`, or the literal en+ru when none is set."""
    if configured:
        return list(configured)
    return list(_PROBE_FAILURE_FALLBACK_LANGS)


def clamp_retrieval_lang(answer_lang: str, corpus_langs: list[str]) -> str:
    """Pick the language to RETRIEVE in for a turn whose ANSWER is in
    `answer_lang`.

    Retrieval is strictly single-language and index-bound, so it must run
    in a real corpus language. If the corpus has `answer_lang`, retrieve in
    it (ru→ru, en→en). Otherwise reduce the locale to a
    content language the same way the client does (`uk`→`ru`, everyone else
    →`en`) and use it when the corpus offers it — so a Ukrainian turn cites
    the Russian purport, matching the website and proactive prompts instead
    of dropping to English. Only when even the reduced language is absent do
    we clamp to English. The answer prose stays in `answer_lang` regardless.
    """
    if answer_lang and answer_lang in corpus_langs:
        return answer_lang
    reduced = reduce_locale_to_content_lang(answer_lang)
    if reduced in corpus_langs:
        return reduced
    return _DEFAULT_RETRIEVAL_LANG


async def resolve_retrieval_lang(
    chunk_repo: Any,
    answer_lang: str,
    *,
    request_id: str | None = None,
    fallback_langs: Sequence[str] = (),
) -> str:
    """Corpus-constrained retrieval language for a turn answering in
    `answer_lang`: probe the corpus languages (`distinct_langs`, cached) and
    `clamp_retrieval_lang`.

    Probe FAILURE vs empty RESULT are handled differently. On an exception
    we clamp against a static fallback set (`fallback_langs`, the configured
    `indexer_langs`, e.g. en+ru), so a transient Postgres/Redis hiccup on a Russian turn still
    retrieves natively instead of being silently forced to English-only.
    Only a genuine EMPTY-corpus RESULT (the probe succeeded and returned [])
    clamps to English via `clamp_retrieval_lang`.

    Shared by `research_worker` and `synthesis_planner` so BOTH attach
    purports in the same corpus language. Otherwise the planner's lazy
    commentary attach would search in the raw answer language (e.g. `sr-Cyrl`),
    find nothing, and fall back to a stray Russian purport — see
    `commentary_expansion._fetch_one`.
    """
    if chunk_repo is not None and hasattr(chunk_repo, "distinct_langs"):
        try:
            corpus_langs = await chunk_repo.distinct_langs()
        except Exception as exc:  # noqa: BLE001 — never fail a turn
            log.warning("distinct_langs_failed", request_id=request_id, error=str(exc))
            # Probe FAILED (not an empty corpus) — clamp against the static
            # fallback set so `answer_lang` can still retrieve natively.
            return clamp_retrieval_lang(answer_lang, fallback_corpus_langs(fallback_langs))
        return clamp_retrieval_lang(answer_lang, corpus_langs)
    # No probe available at all (no repo / no method) — use the static
    # fallback set rather than blindly forcing English.
    return clamp_retrieval_lang(answer_lang, fallback_corpus_langs(fallback_langs))

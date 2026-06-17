"""Unit tests for `LlmTranslationService` — the LLM-backed citation
translator with the Serbian Latin↔Cyrillic economy.

Covers:
- same-language no-op (no LLM round-trip),
- the sr-Cyrl `_normalise_target` / to_cyrillic transliteration path,
- the same-language → Cyrillic guard (fix #3: a `sr-Latn` source requested
  as `sr-Cyrl` must still be transliterated, not handed back as Latin),
- IAST-preservation token-scoping (fix #2: `Kṛṣṇa` stays a proper Serbian
  IAST transliteration while the surrounding Serbian prose becomes Cyrillic),
- the silent `return src` fallback when the LLM fails.

No Redis / Postgres: `kv_cache=None` and a fake Pg cache that always misses
exercise the live-LLM tier directly.
"""

from __future__ import annotations

import pytest

from lectorium_chat.infra.translation.llm_translator import (
    LlmTranslationService,
    serbian_text_to_cyrillic,
)


class _FakePgCache:
    """Always-miss persistent cache; records writes."""

    def __init__(self) -> None:
        self.writes: list[dict] = []

    async def get(self, **_kw):
        return None

    async def put(self, **kw):
        self.writes.append(kw)


class _FakeLLM:
    """Streams a scripted translation. `script` maps source → output; an
    unknown source streams the source verbatim. `boom=True` raises."""

    def __init__(self, script: dict[str, str] | None = None, *, boom: bool = False):
        self._script = script or {}
        self._boom = boom
        self.calls: list[str] = []

    async def stream_completion(self, messages, *, model=None, **_kw):
        # Source text is the tail of the user message after the header.
        user = next(m["content"] for m in messages if m["role"] == "user")
        src = user.split("Text to translate:\n", 1)[1]
        self.calls.append(src)
        if self._boom:
            raise RuntimeError("openrouter 503")
        out = self._script.get(src, src)
        yield {"text": out}


def _service(llm: _FakeLLM) -> LlmTranslationService:
    return LlmTranslationService(
        llm=llm, model="test-model", pg_cache=_FakePgCache(), kv_cache=None,
    )


# ── serbian_text_to_cyrillic (fix #2 unit) ───────────────────────────────


def test_serbian_text_to_cyrillic_plain_prose() -> None:
    # Plain Serbian-Latin (no IAST) → straight Gajica transliteration.
    assert serbian_text_to_cyrillic("ljubav i mir") == "љубав и мир"


def test_serbian_text_to_cyrillic_preserves_iast_names() -> None:
    out = serbian_text_to_cyrillic("Gospod Kṛṣṇa govori u Bhagavad-gītā")
    # IAST names transliterate via the Serbian IAST map (not hybrid garbage):
    # `ṛ`→р+dot-below, `ṣ`→ш, `ṇ`→н+dot-below, `ī`→и+macron — NOT left Latin.
    assert "ṛ" not in out and "ṣ" not in out and "ī" not in out
    # Кṛṣṇа (Latin diacritics passed through) would be the BUG; the IAST map
    # yields a clean Serbian-Cyrillic transliteration (кр̣шн̣а — case-folded,
    # as the IAST map documents). The point is no half-converted Latin.
    assert "кр" in out
    # Surrounding Serbian prose is Cyrillic.
    assert "Господ" in out and "говори" in out


# ── translate() — same-language no-op ─────────────────────────────────────


@pytest.mark.asyncio
async def test_same_language_noop_no_llm() -> None:
    llm = _FakeLLM()
    svc = _service(llm)
    out = await svc.translate("native text", src_lang="en", tgt_lang="en")
    assert out == "native text"
    assert llm.calls == []  # never round-tripped through the LLM


@pytest.mark.asyncio
async def test_empty_text_returns_as_is() -> None:
    llm = _FakeLLM()
    out = await _service(llm).translate("   ", src_lang="en", tgt_lang="uk")
    assert out == "   "
    assert llm.calls == []


# ── translate() — sr-Cyrl transliteration path ────────────────────────────


@pytest.mark.asyncio
async def test_sr_cyrl_translates_then_transliterates() -> None:
    # LLM returns Serbian Latin; service transliterates to Cyrillic.
    llm = _FakeLLM({"the source": "ljubav"})
    out = await _service(llm).translate(
        "the source", src_lang="en", tgt_lang="sr-Cyrl",
    )
    assert out == "љубав"
    # Cache language is normalised to sr-Latn (one row for both scripts).
    assert llm.calls == ["the source"]


@pytest.mark.asyncio
async def test_sr_cyrl_preserves_iast_in_translation() -> None:
    """fix #2: the translated Serbian Latin keeps IAST names; only the
    surrounding prose is transliterated to Cyrillic."""
    llm = _FakeLLM({"src": "Gospod Kṛṣṇa"})
    out = await _service(llm).translate("src", src_lang="en", tgt_lang="sr-Cyrl")
    assert "Господ" in out
    assert "ṛ" not in out and "ṣ" not in out  # no Latin diacritics left
    assert "кр" in out


# ── translate() — same-language → Cyrillic guard (fix #3) ──────────────────


@pytest.mark.asyncio
async def test_sr_latin_source_to_cyrl_still_transliterates() -> None:
    """A `sr-Latn` source requested as `sr-Cyrl`: cache langs match
    (both sr-Latn) so the LLM is skipped, but the result MUST still be
    transliterated Latin→Cyrillic — handing back Latin to a Cyrillic user
    is the bug this fix closes."""
    llm = _FakeLLM()
    out = await _service(llm).translate(
        "ljubav", src_lang="sr-Latn", tgt_lang="sr-Cyrl",
    )
    assert out == "љубав"
    assert llm.calls == []  # same-language → no LLM call


@pytest.mark.asyncio
async def test_sr_latin_source_to_sr_latin_noop() -> None:
    # sr-Latn → sr-Latn: same language, no transliteration, no LLM.
    llm = _FakeLLM()
    out = await _service(llm).translate(
        "ljubav", src_lang="sr-Latn", tgt_lang="sr-Latn",
    )
    assert out == "ljubav"
    assert llm.calls == []


# ── translate() — LLM failure fallback ────────────────────────────────────


@pytest.mark.asyncio
async def test_llm_failure_returns_source() -> None:
    """All retries fail → service silently returns the source text (the
    turn never fails on a translation miss)."""
    llm = _FakeLLM(boom=True)
    svc = LlmTranslationService(
        llm=llm, model="m", pg_cache=_FakePgCache(), kv_cache=None,
        max_retries=0,
    )
    out = await svc.translate("the source", src_lang="en", tgt_lang="uk")
    assert out == "the source"


@pytest.mark.asyncio
async def test_plain_locale_translates_without_transliteration() -> None:
    llm = _FakeLLM({"the source": "джерело"})
    out = await _service(llm).translate(
        "the source", src_lang="en", tgt_lang="uk",
    )
    assert out == "джерело"  # returned verbatim, no sr transliteration

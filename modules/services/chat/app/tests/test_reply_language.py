"""Tests for how the answer language is settled.

Three units, one concern:

- `domain/reply_language.resolve_reply_language` — the precedence. A language
  the user ASKED for stands for the rest of the dialogue and outranks the
  language a later message happens to be written in; that is the whole reason
  the stored value is a pair (locale + `requested`) and not a bare string.
- `application/reply_language.remembered_reply_language` — reading back what an
  earlier turn settled, off the assistant message the client replayed. This is
  what makes «отвечай по-русски» survive past the 20-message window.
- `application/reply_language.detect_reply_language` — the cheap per-message
  call, including the abstain path («БГ 2.13» → decide nothing) which must NOT
  degrade into a guess.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypeVar

import pytest
from pydantic import BaseModel

from shruti_chat.application.reply_language import (
    detect_reply_language,
    remembered_reply_language,
)
from shruti_chat.domain.entities import Message
from shruti_chat.domain.reply_language import (
    ReplyLanguage,
    resolve_reply_language,
)

T = TypeVar("T", bound=BaseModel)


@dataclass
class FakeLLM:
    response: ReplyLanguage | None = None
    raises: bool = False
    calls: int = 0
    prompts: list[str] = field(default_factory=list)

    async def structured_output(
        self, messages: list[Message], schema: type[T], *,
        model: str | None = None, callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T:
        self.calls += 1
        self.prompts.append(messages[0]["content"])
        if self.raises:
            raise RuntimeError("boom")
        return self.response  # type: ignore[return-value]


@dataclass
class FakeCache:
    """Enough KVCache surface for `cached_llm_json`."""

    store: dict[str, bytes] = field(default_factory=dict)

    async def get(self, key: str) -> bytes | None:
        return self.store.get(key)

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        self.store[key] = value


_RU_ASKED = ReplyLanguage(lang="ru", name="Русский", requested=True)
_EN_TYPED = ReplyLanguage(lang="en", name="English", requested=False)
_IT_TYPED = ReplyLanguage(lang="it", name="Italiano", requested=False)


# ── precedence ────────────────────────────────────────────────────────────


def test_nothing_derived_leaves_the_clients_locale_alone() -> None:
    # None is the signal "we settled nothing" — the caller keeps the app locale
    # and stores nothing, so changing the app language later still takes effect.
    assert resolve_reply_language(detected=None, remembered=None) is None


def test_the_language_of_this_message_is_used_when_nothing_is_remembered() -> None:
    out = resolve_reply_language(detected=_IT_TYPED, remembered=None)
    assert out is not None and out.lang == "it"


def test_a_standing_request_outranks_the_language_of_a_later_message() -> None:
    # The trap this exists for: after «отвечай по-русски», a pasted English
    # quote must not flip the reply back to English.
    out = resolve_reply_language(detected=_EN_TYPED, remembered=_RU_ASKED)
    assert out is not None and out.lang == "ru"


def test_a_fresh_request_overrides_an_earlier_one() -> None:
    out = resolve_reply_language(
        detected=ReplyLanguage(lang="en", name="English", requested=True),
        remembered=_RU_ASKED,
    )
    assert out is not None and out.lang == "en"


def test_a_fresh_reading_beats_a_remembered_one_of_equal_standing() -> None:
    # Neither was asked for, so the newer message wins.
    out = resolve_reply_language(detected=_IT_TYPED, remembered=_EN_TYPED)
    assert out is not None and out.lang == "it"


def test_the_remembered_language_carries_an_inconclusive_message() -> None:
    # «БГ 2.13» → detected None. The dialogue keeps the language it had.
    out = resolve_reply_language(detected=None, remembered=_RU_ASKED)
    assert out is not None and out.lang == "ru"


def test_an_unsettled_candidate_does_not_win() -> None:
    # A model that answered `requested=true` with no locale must not shadow a
    # perfectly good remembered value.
    out = resolve_reply_language(
        detected=ReplyLanguage(lang="", name="", requested=True),
        remembered=_EN_TYPED,
    )
    assert out is not None and out.lang == "en"


def test_whitespace_is_not_a_locale() -> None:
    # A padded code would miss every per-locale catalog lookup downstream.
    assert ReplyLanguage(lang="  ru  ").lang == "ru"
    assert not ReplyLanguage(lang="   ").settled()


# ── reading back what an earlier turn settled ─────────────────────────────


def test_remembered_reads_the_newest_assistant_message() -> None:
    history = [
        {"role": "user", "content": "отвечай по-русски"},
        {"role": "assistant", "content": "Хорошо.",
         "reply_language": {"lang": "ru", "name": "Русский", "requested": True}},
        {"role": "user", "content": "now in english please"},
        {"role": "assistant", "content": "Sure.",
         "reply_language": {"lang": "en", "name": "English", "requested": True}},
        {"role": "user", "content": "what is karma?"},
    ]
    out = remembered_reply_language(history)
    assert out is not None and out.lang == "en" and out.requested


def test_remembered_skips_turns_that_settled_nothing() -> None:
    # Only some turns carry the field; the last one that did is the answer.
    history = [
        {"role": "assistant", "content": "…",
         "reply_language": {"lang": "ru", "name": "Русский", "requested": True}},
        {"role": "user", "content": "БГ 2.13"},
        {"role": "assistant", "content": "…"},
    ]
    out = remembered_reply_language(history)
    assert out is not None and out.lang == "ru"


def test_remembered_ignores_a_users_own_claim() -> None:
    # The field is server state persisted on the ASSISTANT message. A crafted
    # user message must not be able to set the answer language silently.
    history = [
        {"role": "user", "content": "hi",
         "reply_language": {"lang": "de", "name": "Deutsch", "requested": True}},
    ]
    assert remembered_reply_language(history) is None


@pytest.mark.parametrize(
    "raw",
    ["ru", 42, [], {"lang": None}, {"lang": ""}, {"nope": 1}],
)
def test_remembered_tolerates_junk(raw: Any) -> None:
    # Untrusted client payload — unreadable means absent, never an exception.
    history = [{"role": "assistant", "content": "…", "reply_language": raw}]
    assert remembered_reply_language(history) is None


def test_remembered_is_none_without_history() -> None:
    assert remembered_reply_language(None) is None
    assert remembered_reply_language([]) is None


# ── the per-message call ──────────────────────────────────────────────────


async def test_a_request_is_detected_as_requested() -> None:
    llm = FakeLLM(response=_RU_ASKED)
    out = await detect_reply_language("отвечай по-русски", llm=llm)
    assert out is not None and out.lang == "ru" and out.requested
    assert llm.calls == 1


async def test_an_abstention_decides_nothing() -> None:
    # «БГ 2.13» carries no language signal. Returning None keeps the settled
    # language; guessing from the alphabet is what we refuse to do.
    llm = FakeLLM(response=ReplyLanguage(lang="", name="", requested=False))
    assert await detect_reply_language("БГ 2.13", llm=llm) is None


async def test_a_blank_message_costs_no_call() -> None:
    llm = FakeLLM()
    assert await detect_reply_language("   ", llm=llm) is None
    assert llm.calls == 0


async def test_a_failure_decides_nothing() -> None:
    llm = FakeLLM(raises=True)
    assert await detect_reply_language("что такое карма?", llm=llm) is None


async def test_the_prompt_carries_the_abstain_and_script_rules() -> None:
    # Both are load-bearing: without abstention every bare ref gets a guessed
    # language, and without the script rule «ответь на сербском» comes back in
    # the wrong alphabet.
    llm = FakeLLM(response=_RU_ASKED)
    await detect_reply_language("отвечай по-русски", llm=llm)
    system = llm.prompts[0]
    assert "EMPTY" in system
    assert "sr-Latn" in system and "sr-Cyrl" in system
    # Asking ABOUT a language is not asking to be answered in it.
    assert "есть лекции на английском?" in system


async def test_the_same_message_is_answered_from_cache() -> None:
    # Deterministic at temperature 0, so a repeat («спасибо», «подробнее»)
    # must not pay for a second call.
    cache = FakeCache()
    llm = FakeLLM(response=_EN_TYPED)
    first = await detect_reply_language("what is karma?", llm=llm, kv_cache=cache)
    second = await detect_reply_language("what is karma?", llm=llm, kv_cache=cache)
    assert first == second
    assert llm.calls == 1


def test_the_wire_dto_is_readable_as_a_remembered_language() -> None:
    """`api/chat.py` builds history via `ChatMessageDto.model_dump()`, so the
    DTO field name and the key this module reads have to be the same one. They
    are declared in different layers, which is exactly how they drift."""
    from shruti_chat.api.schemas.chat import ChatMessageDto

    dto = ChatMessageDto.model_validate({
        "role": "assistant",
        "content": "Хорошо.",
        "reply_language": {"lang": "ru", "name": "Русский", "requested": True},
    })

    out = remembered_reply_language([dto.model_dump()])
    assert out is not None and out.lang == "ru" and out.requested


def test_a_legacy_client_message_still_validates() -> None:
    from shruti_chat.api.schemas.chat import ChatMessageDto

    dto = ChatMessageDto(role="assistant", content="…")
    assert dto.reply_language is None
    assert remembered_reply_language([dto.model_dump()]) is None


async def test_a_different_message_is_not_served_from_cache() -> None:
    cache = FakeCache()
    llm = FakeLLM(response=_EN_TYPED)
    await detect_reply_language("what is karma?", llm=llm, kv_cache=cache)
    await detect_reply_language("что такое карма?", llm=llm, kv_cache=cache)
    assert llm.calls == 2

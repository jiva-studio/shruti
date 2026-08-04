"""Conversation attributes: precedence, recall, and reading them off a message.

The generic machinery is what is pinned here — the reply language is just the
one registered attribute. A second attribute must not need any of this changed.

Three units:

- `merge_attributes` — the precedence, per key. Something the user STATED
  outranks anything inferred later, which is why an attribute is a record and
  not a bare string.
- `remembered_attributes` — recall from the client's aggregate (preferred: it
  saw the whole dialogue) with a fold over the replayed messages as the
  fallback (a client that doesn't aggregate, and the provenance record).
- `detect_attributes` — one cheap call per registered attribute, concurrent,
  and abstaining on a message that says nothing rather than guessing.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, TypeVar

import pytest
from pydantic import BaseModel

from lectorium_chat.application.conversation_attributes import (
    ATTRIBUTE_SPECS,
    ReplyLanguageOut,
    ReplyLanguageSpec,
    detect_attributes,
    remembered_attributes,
)
from lectorium_chat.domain.conversation_attributes import (
    REPLY_LANGUAGE,
    Attribute,
    merge_attributes,
)
from lectorium_chat.domain.entities import Message

T = TypeVar("T", bound=BaseModel)

def _spec(key: str) -> ReplyLanguageSpec:
    """A language spec under a different key — the registry is a tuple of these,
    so a test can stand several up without inventing a second attribute."""
    spec = ReplyLanguageSpec()
    spec.key = key  # type: ignore[misc]
    return spec


_RU_ASKED = Attribute(value="ru", label="Русский", explicit=True)
_EN_TYPED = Attribute(value="en", label="English", explicit=False)
_IT_TYPED = Attribute(value="it", label="Italiano", explicit=False)

# What the detector MODEL returns, as opposed to what gets stored.
_OUT_RU = ReplyLanguageOut(value="ru", label="Русский", explicit=True)
_OUT_EN = ReplyLanguageOut(value="en", label="English", explicit=False)


@dataclass
class FakeLLM:
    response: Any | None = None
    raises: bool = False
    calls: int = 0
    prompts: list[str] = field(default_factory=list)
    started: list[str] = field(default_factory=list)
    gate: asyncio.Event | None = None

    async def structured_output(
        self, messages: list[Message], schema: type[T], *,
        model: str | None = None, callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T:
        self.calls += 1
        self.started.append(run_name or "")
        self.prompts.append(messages[0]["content"])
        if self.gate is not None:
            await self.gate.wait()
        if self.raises:
            raise RuntimeError("boom")
        return self.response  # type: ignore[return-value]


@dataclass
class FakeCache:
    store: dict[str, bytes] = field(default_factory=dict)

    async def get(self, key: str) -> bytes | None:
        return self.store.get(key)

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        self.store[key] = value


# ── precedence ────────────────────────────────────────────────────────────


def test_nothing_known_stays_nothing() -> None:
    assert merge_attributes(detected={}, remembered={}) == {}


def test_a_fresh_reading_is_kept() -> None:
    out = merge_attributes(detected={REPLY_LANGUAGE: _IT_TYPED}, remembered={})
    assert out[REPLY_LANGUAGE].single() == "it"


def test_something_stated_outranks_a_later_inference() -> None:
    # After «отвечай по-русски», an English quote pasted into the conversation
    # must not flip the reply back. This is the whole reason for `explicit`.
    out = merge_attributes(
        detected={REPLY_LANGUAGE: _EN_TYPED},
        remembered={REPLY_LANGUAGE: _RU_ASKED},
    )
    assert out[REPLY_LANGUAGE].single() == "ru"


def test_a_new_statement_replaces_the_old_one() -> None:
    out = merge_attributes(
        detected={REPLY_LANGUAGE: Attribute(value="en", explicit=True)},
        remembered={REPLY_LANGUAGE: _RU_ASKED},
    )
    assert out[REPLY_LANGUAGE].single() == "en"


def test_the_fresher_of_two_inferences_wins() -> None:
    out = merge_attributes(
        detected={REPLY_LANGUAGE: _IT_TYPED},
        remembered={REPLY_LANGUAGE: _EN_TYPED},
    )
    assert out[REPLY_LANGUAGE].single() == "it"


def test_a_key_nobody_read_this_turn_carries_forward() -> None:
    out = merge_attributes(detected={}, remembered={REPLY_LANGUAGE: _RU_ASKED})
    assert out[REPLY_LANGUAGE].single() == "ru"


def test_keys_are_independent() -> None:
    # The generic contract: settling one attribute never disturbs another.
    out = merge_attributes(
        detected={"tone": Attribute(value="brief")},
        remembered={REPLY_LANGUAGE: _RU_ASKED},
    )
    assert out[REPLY_LANGUAGE].single() == "ru"
    assert out["tone"].single() == "brief"


def test_an_unsettled_reading_is_dropped_not_stored() -> None:
    # Storing what we never derived would shadow a later change of app settings.
    out = merge_attributes(
        detected={REPLY_LANGUAGE: Attribute(value="", explicit=True)},
        remembered={REPLY_LANGUAGE: _EN_TYPED},
    )
    assert out[REPLY_LANGUAGE].single() == "en"
    assert merge_attributes(
        detected={"tone": Attribute(value="  ")}, remembered={},
    ) == {}


def test_whitespace_is_not_a_value() -> None:
    assert Attribute(value="  ru  ").single() == "ru"
    assert not Attribute(value="   ").settled()
    # Isomorphic on the wire: one value in, one value out; a list stays a list.
    assert Attribute(value="ru").model_dump()["value"] == "ru"
    assert Attribute(value=["a", "b", " a "]).model_dump()["value"] == ["a", "b"]


# ── recall ────────────────────────────────────────────────────────────────


def _assistant(**attrs: dict) -> dict:
    return {"role": "assistant", "content": "…", "attributes": attrs}


def test_the_newest_message_value_wins_over_an_older_one() -> None:
    history = [
        {"role": "user", "content": "отвечай по-русски"},
        _assistant(reply_language={"value": "ru", "label": "Русский", "explicit": True}),
        {"role": "user", "content": "now in english"},
        _assistant(reply_language={"value": "en", "label": "English", "explicit": True}),
    ]
    out = remembered_attributes(history)
    assert out[REPLY_LANGUAGE].single() == "en"


def test_the_clients_aggregate_is_preferred_over_the_messages() -> None:
    # The point of the aggregate: it saw turns the 20-message window dropped.
    history = [_assistant(reply_language={"value": "en", "label": "English"})]
    out = remembered_attributes(
        history, {"reply_language": {"value": "ru", "label": "Русский", "explicit": True}}
    )
    assert out[REPLY_LANGUAGE].single() == "ru"


def test_the_messages_still_answer_a_client_that_sends_no_aggregate() -> None:
    history = [_assistant(reply_language={"value": "ru", "label": "Русский", "explicit": True})]
    out = remembered_attributes(history, None)
    assert out[REPLY_LANGUAGE].single() == "ru"


def test_a_stale_aggregate_cannot_undo_something_stated() -> None:
    # Aggregate and messages are the same data; the merge rule settles a
    # disagreement rather than one source blindly winning.
    history = [_assistant(reply_language={"value": "ru", "label": "Русский", "explicit": True})]
    out = remembered_attributes(history, {"reply_language": {"value": "en"}})
    assert out[REPLY_LANGUAGE].single() == "ru"


def test_a_users_own_claim_is_ignored() -> None:
    # Server state lives on the ASSISTANT message; a crafted user message must
    # not be able to set an attribute.
    history = [{
        "role": "user", "content": "hi",
        "attributes": {"reply_language": {"value": "de", "explicit": True}},
    }]
    assert remembered_attributes(history) == {}


@pytest.mark.parametrize(
    "raw", ["ru", 42, [], {"reply_language": "ru"}, {"reply_language": {"value": ""}},
            {7: {"value": "ru"}}],
)
def test_junk_is_absent_not_fatal(raw: Any) -> None:
    assert remembered_attributes([{"role": "assistant", "content": "…", "attributes": raw}]) == {}
    assert remembered_attributes(None, raw) == {}


def test_one_bad_entry_does_not_cost_the_others() -> None:
    out = remembered_attributes(None, {
        "reply_language": {"value": "ru"},
        "broken": "not an object",
    })
    assert out[REPLY_LANGUAGE].single() == "ru"


def test_no_history_no_attributes() -> None:
    assert remembered_attributes(None) == {}
    assert remembered_attributes([]) == {}


# ── detection ─────────────────────────────────────────────────────────────


async def test_the_registered_attribute_is_read_off_the_message() -> None:
    llm = FakeLLM(response=_OUT_RU)
    out = await detect_attributes(
        "отвечай по-русски", llm=llm, specs=(ReplyLanguageSpec(),),
    )
    assert out[REPLY_LANGUAGE].single() == "ru"
    assert out[REPLY_LANGUAGE].explicit
    assert llm.calls == 1


async def test_an_abstention_is_an_absent_key() -> None:
    # «БГ 2.13» says nothing about language. Absent ⇒ the settled value carries.
    llm = FakeLLM(response=ReplyLanguageOut())
    assert await detect_attributes("БГ 2.13", llm=llm) == {}


async def test_a_failure_is_an_absent_key_too() -> None:
    assert await detect_attributes("что такое карма?", llm=FakeLLM(raises=True)) == {}


async def test_a_blank_message_costs_no_call() -> None:
    llm = FakeLLM()
    assert await detect_attributes("   ", llm=llm) == {}
    assert llm.calls == 0


async def test_every_attribute_is_read_concurrently() -> None:
    """N attributes cost ONE round-trip of wall-clock, not N. Asserted by
    gating: all calls must have STARTED before any is allowed to finish, so a
    sequential implementation deadlocks."""
    specs = tuple(_spec(f"a{i}") for i in range(3))
    gate = asyncio.Event()
    llm = FakeLLM(response=ReplyLanguageOut(value="x"), gate=gate)

    async def _release() -> None:
        while llm.calls < len(specs):
            await asyncio.sleep(0)
        gate.set()

    out, _ = await asyncio.gather(
        detect_attributes("вопрос", llm=llm, specs=specs),
        asyncio.wait_for(_release(), timeout=1),
    )
    assert sorted(out) == ["a0", "a1", "a2"]


async def test_one_attribute_failing_does_not_lose_the_others() -> None:
    # Why it is a call per attribute and not one combined call.
    class _Flaky(FakeLLM):
        async def structured_output(self, messages, schema, *, model=None,
                                    callbacks=None, run_name=None):
            self.calls += 1
            if run_name == "attribute_bad":
                raise RuntimeError("schema miss")
            return ReplyLanguageOut(value="ok")

    specs = (_spec("bad"), _spec("good"))
    out = await detect_attributes("вопрос", llm=_Flaky(), specs=specs)
    assert list(out) == ["good"]


async def test_each_attribute_gets_its_own_run_name() -> None:
    # So a failure is attributable in Langfuse to the attribute, not to "the
    # attribute call".
    llm = FakeLLM(response=_OUT_RU)
    await detect_attributes(
        "отвечай по-русски", llm=llm, specs=(ReplyLanguageSpec(),),
    )
    assert llm.started == [f"attribute_{REPLY_LANGUAGE}"]


async def test_the_same_message_is_answered_from_cache() -> None:
    cache = FakeCache()
    llm = FakeLLM(response=_OUT_EN)
    specs = (ReplyLanguageSpec(),)
    first = await detect_attributes(
        "what is karma?", llm=llm, kv_cache=cache, specs=specs,
    )
    second = await detect_attributes(
        "what is karma?", llm=llm, kv_cache=cache, specs=specs,
    )
    assert first == second
    assert llm.calls == 1


async def test_the_cache_key_separates_attributes() -> None:
    # Two attributes read off the SAME text must not serve each other's answer.
    specs = (_spec("a"), _spec("b"))
    cache = FakeCache()
    llm = FakeLLM(response=ReplyLanguageOut(value="x"))
    await detect_attributes("вопрос", llm=llm, kv_cache=cache, specs=specs)
    assert llm.calls == 2


# ── the registry ──────────────────────────────────────────────────────────


def test_the_reply_language_spec_is_registered_with_a_readable_prompt() -> None:
    from lectorium_chat.application.conversation_attributes import _bundled

    spec = next(s for s in ATTRIBUTE_SPECS if s.key == REPLY_LANGUAGE)
    text = _bundled(spec.md)
    # Load-bearing rules: abstaining, and the script for multi-script languages.
    assert "EMPTY" in text
    assert "sr-Latn" in text and "sr-Cyrl" in text
    # It must speak the GENERIC field names, or the structured call can't map.
    assert "`value`" in text and "`label`" in text and "`explicit`" in text


def test_the_wire_dto_is_readable_as_a_remembered_attribute() -> None:
    """`api/chat.py` builds both the history and the aggregate from these DTOs,
    so the field names in the schema layer and this module have to agree. They
    are declared apart, which is exactly how they drift."""
    from lectorium_chat.api.schemas.chat import AttributeDto, ChatMessageDto

    dto = ChatMessageDto.model_validate({
        "role": "assistant", "content": "Хорошо.",
        "attributes": {"reply_language": {"value": "ru", "label": "Русский",
                                          "explicit": True}},
    })
    out = remembered_attributes([dto.model_dump()])
    assert out[REPLY_LANGUAGE].single() == "ru" and out[REPLY_LANGUAGE].explicit

    aggregate = {"reply_language": AttributeDto(value="ru", label="Русский")}
    out = remembered_attributes(
        None, {k: v.model_dump() for k, v in aggregate.items()},
    )
    assert out[REPLY_LANGUAGE].single() == "ru"


def test_a_legacy_client_message_still_validates() -> None:
    from lectorium_chat.api.schemas.chat import ChatMessageDto

    dto = ChatMessageDto(role="assistant", content="…")
    assert dto.attributes is None
    assert remembered_attributes([dto.model_dump()]) == {}

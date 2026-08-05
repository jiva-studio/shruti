"""The LiteLLM path must not call a provider without a timeout.

`/title` and `/questions` reach the provider through `agent/llm.acompletion`,
not through `LLMPort` — so they never got the OpenRouter adapter's 180s cap,
and LiteLLM itself defaults to no request timeout. A hung upstream held the
user's HTTP request open indefinitely, with nothing to break it.
"""

from __future__ import annotations

from typing import Any

import pytest

from lectorium_chat.agent import llm as llm_mod


@pytest.fixture(autouse=True)
def _capture(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    async def _fake_acompletion(**kwargs: Any) -> Any:
        seen.update(kwargs)

        class _Empty:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

        return _Empty()

    monkeypatch.setattr(llm_mod.litellm, "acompletion", _fake_acompletion)
    # configure_providers() mutates os.environ and is memoised; skip it.
    monkeypatch.setattr(llm_mod, "configure_providers", lambda *a, **k: None)
    return seen


async def test_oneshot_call_carries_a_timeout(_capture: dict[str, Any]) -> None:
    await llm_mod.acompletion("openrouter/x", [{"role": "user", "content": "hi"}])

    assert _capture["timeout"] == llm_mod.get_settings().llm_oneshot_timeout_s


async def test_caller_supplied_timeout_wins(_capture: dict[str, Any]) -> None:
    await llm_mod.acompletion(
        "openrouter/x", [{"role": "user", "content": "hi"}], timeout=3.0,
    )

    assert _capture["timeout"] == 3.0


async def test_streaming_gets_the_longer_ceiling(_capture: dict[str, Any]) -> None:
    # A streamed generation legitimately outlives a one-shot call, so it takes
    # the same horizon the OpenRouter adapter uses rather than the short one.
    async for _ in llm_mod.stream_completion(
        "openrouter/x", [{"role": "user", "content": "hi"}],
    ):
        pass

    assert _capture["timeout"] == llm_mod._STREAM_TIMEOUT_S

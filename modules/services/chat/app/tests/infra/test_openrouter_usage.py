"""Unit tests for the OpenRouter provider's token-usage extraction —
specifically the prompt-cache (`cache_read`) visibility added so we can
confirm implicit-cache hits for Gemini/DeepSeek.
"""

from __future__ import annotations

from langchain_core.messages import AIMessageChunk

from shruti_chat.infra.llm_provider.openrouter import (
    _chunk_to_domain,
    _usage_details,
)


def test_usage_details_no_cache_is_unchanged_shape():
    # No cache hit → identical to the legacy {input, output} payload.
    assert _usage_details(1000, 200, 0) == {"input": 1000, "output": 200}


def test_usage_details_splits_cached_prefix_keeping_total():
    # On a hit, prompt tokens split into uncached `input` + `cache_read`;
    # input + cache_read still equals the original prompt total (1000).
    d = _usage_details(1000, 200, 800)
    assert d == {"input": 200, "cache_read": 800, "output": 200}
    assert d["input"] + d["cache_read"] == 1000


def test_usage_details_clamps_when_cached_exceeds_input():
    # Defensive: a provider reporting cache_read > input never goes negative.
    d = _usage_details(500, 50, 900)
    assert d["input"] == 0
    assert d["cache_read"] == 900


def test_chunk_to_domain_extracts_cache_read():
    chunk = AIMessageChunk(
        content="hi",
        usage_metadata={
            "input_tokens": 1000,
            "output_tokens": 20,
            "total_tokens": 1020,
            "input_token_details": {"cache_read": 768},
        },
    )
    out = _chunk_to_domain(chunk)
    assert out["prompt_tokens"] == 1000
    assert out["completion_tokens"] == 20
    assert out["cached_tokens"] == 768


def test_chunk_to_domain_omits_cache_read_when_absent():
    chunk = AIMessageChunk(
        content="hi",
        usage_metadata={"input_tokens": 1000, "output_tokens": 20, "total_tokens": 1020},
    )
    out = _chunk_to_domain(chunk)
    assert "cached_tokens" not in out

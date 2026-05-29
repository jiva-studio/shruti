"""LLMPort implementations.

Single adapter today: `OpenRouterLLMProvider`. It reaches every Western
model (Gemini, Claude, DeepSeek, OpenAI) through one OpenAI-compatible
endpoint via `langchain_openai.ChatOpenAI` with `base_url=` overridden.

#729: The `LLMPort.structured_output(messages, schema, *, model, callbacks,
run_name) -> T` contract is the only structured-output surface chat code
relies on. Any future provider adapter MUST implement it via the provider's
native JSON-schema enforcement (OpenRouter: `with_structured_output`;
OpenAI: `response_format={"type":"json_schema",...}`; GigaChat 2: function
calling; Yandex Pro: `jsonSchema`) — fence-stripping fallbacks are forbidden.

`build_llm_provider(settings)` is the canonical dispatch: composition
root calls it once at startup; tests call it to assert the LLM_PROVIDER
→ adapter mapping without booting the full lifespan.
"""

from __future__ import annotations

from shruti_chat.config import Settings
from shruti_chat.domain.ports.llm_provider import LLMPort
from shruti_chat.infra.llm_provider.openrouter import OpenRouterLLMProvider


__all__ = [
    "OpenRouterLLMProvider",
    "build_llm_provider",
]


def build_llm_provider(settings: Settings) -> LLMPort:
    """Branch on `settings.llm_provider` and return the matching adapter."""
    match settings.llm_provider:
        case "openrouter":
            return OpenRouterLLMProvider(settings)
        case other:  # pragma: no cover — Literal guards this
            raise ValueError(
                f"unknown LLM_PROVIDER={other!r}; allowed: openrouter"
            )

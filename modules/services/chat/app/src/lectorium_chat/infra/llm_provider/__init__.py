"""LLMPort implementations.

Three adapters live here:

- `OpenRouterLLMProvider` — default for the global region. Reaches all
  Western models (Gemini, Claude, DeepSeek, OpenAI) through one
  OpenAI-compatible endpoint. Implementation rides
  `langchain_openai.ChatOpenAI` with `base_url=` overridden.
- `YandexLLMProvider` — YandexGPT 5 (Lite/Pro) via the Yandex Cloud
  Foundation Models REST API. Direct httpx — no langchain.
  Tool / function-calling is NotImplemented; structured output is a
  prompt-and-parse fallback.
- `GigaChatLLMProvider` — Sber GigaChat (Lite/Pro/Max) over the
  OpenAI-shaped chat-completions endpoint with OAuth2 client-credentials
  auth. Function-calling supported (legacy `functions` shape).

`build_llm_provider(settings)` is the canonical dispatch: composition
root calls it once at startup; tests call it to assert the LLM_PROVIDER
→ adapter mapping without booting the full lifespan.
"""

from __future__ import annotations

from lectorium_chat.config import Settings
from lectorium_chat.domain.ports.llm_provider import LLMPort
from lectorium_chat.infra.llm_provider.gigachat import GigaChatLLMProvider
from lectorium_chat.infra.llm_provider.openrouter import OpenRouterLLMProvider
from lectorium_chat.infra.llm_provider.yandex import YandexLLMProvider


__all__ = [
    "GigaChatLLMProvider",
    "OpenRouterLLMProvider",
    "YandexLLMProvider",
    "build_llm_provider",
]


def build_llm_provider(settings: Settings) -> LLMPort:
    """Branch on `settings.llm_provider` and return the matching adapter.

    The `Settings` `model_validator` already enforced that the chosen
    branch's required envs are populated; this function only cares
    about adapter selection. Russia VPS deploys with `yandex` or
    `gigachat`; global stays on `openrouter`.

    Unknown values are caught by the `Literal` on `Settings.llm_provider`
    (pydantic rejects at construction), but the `case _:` arm stays as
    defence-in-depth in case the Literal is loosened later.
    """
    match settings.llm_provider:
        case "openrouter":
            return OpenRouterLLMProvider(settings)
        case "yandex":
            return YandexLLMProvider(
                settings, concurrency=settings.llm_concurrency,
            )
        case "gigachat":
            return GigaChatLLMProvider(settings)
        case other:  # pragma: no cover — Literal guards this
            raise ValueError(
                f"unknown LLM_PROVIDER={other!r}; "
                "allowed: openrouter | yandex | gigachat"
            )

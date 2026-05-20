"""LLMPort implementations.

`OpenRouterLLMProvider` wraps `langchain_openai.ChatOpenAI` pointed at
OpenRouter's OpenAI-compatible endpoint. This is the default provider —
all production models (Gemini Flash Lite, Haiku, Sonnet) are reached
through OpenRouter, so one adapter covers the full tier.
"""

from lectorium_chat.infra.llm_provider.openrouter import OpenRouterLLMProvider

__all__ = ["OpenRouterLLMProvider"]

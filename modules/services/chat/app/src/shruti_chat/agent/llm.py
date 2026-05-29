"""LLM access via LiteLLM.

LiteLLM picks the provider based on model prefix (`openrouter/...`,
`anthropic/...`, `openai/...`). We register the active providers'
credentials in env at process start; LiteLLM reads them globally.
"""

from __future__ import annotations

import os
from typing import Any, AsyncIterator

import litellm

from shruti_chat.config import Settings, get_settings
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

_INITIALIZED = False


def configure_providers(settings: Settings | None = None) -> None:
    """Populate LiteLLM's env-vars from our Settings. Idempotent."""
    global _INITIALIZED
    if _INITIALIZED:
        return
    s = settings or get_settings()
    if s.openrouter_api_key:
        os.environ["OPENROUTER_API_KEY"] = s.openrouter_api_key
    if s.anthropic_api_key:
        os.environ["ANTHROPIC_API_KEY"] = s.anthropic_api_key
    if s.openai_api_key:
        os.environ["OPENAI_API_KEY"] = s.openai_api_key

    # Quieter — LiteLLM tends to be chatty
    litellm.suppress_debug_info = True
    _INITIALIZED = True
    log.info(
        "llm_providers_configured",
        openrouter=bool(s.openrouter_api_key),
        anthropic=bool(s.anthropic_api_key),
        openai=bool(s.openai_api_key),
        default=s.llm_default,
    )


async def acompletion(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict] | None = None,
    stream: bool = False,
    **kwargs: Any,
) -> Any:
    """Thin wrapper around litellm.acompletion."""
    configure_providers()
    return await litellm.acompletion(
        model=model,
        messages=messages,
        tools=tools,
        stream=stream,
        **kwargs,
    )


async def stream_completion(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict] | None = None,
    **kwargs: Any,
) -> AsyncIterator[Any]:
    """Async iterator over streaming chunks."""
    configure_providers()
    resp = await litellm.acompletion(
        model=model,
        messages=messages,
        tools=tools,
        stream=True,
        **kwargs,
    )
    async for chunk in resp:
        yield chunk

"""Thin litellm/OpenRouter wrapper for outline generation.

Mirrors the chat service's `agent.llm`: provider is chosen by the model
prefix (`openrouter/...`), the API key comes from `OPENROUTER_API_KEY`.
"""

from __future__ import annotations

import os
from typing import Any

import litellm

from share_transcript.config import Settings


def configure(settings: Settings) -> None:
    if settings.openrouter_api_key:
        os.environ["OPENROUTER_API_KEY"] = settings.openrouter_api_key
    # Keep noisy provider banners out of structured logs; tolerate models
    # that reject an unknown kwarg instead of 400-ing the whole call.
    litellm.suppress_debug_info = True
    litellm.drop_params = True


async def acompletion(*, model: str, messages: list[dict[str, Any]], temperature: float) -> Any:
    return await litellm.acompletion(model=model, messages=messages, temperature=temperature)

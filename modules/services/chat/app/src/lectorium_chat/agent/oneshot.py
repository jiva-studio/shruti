"""Tiny LLM one-shot helper shared by `/title` and `/questions`.

These endpoints have the same shape: small system prompt + small user
prompt → short text reply. No tools, no streaming, no RAG. The wrapper
centralises the litellm call + exception swallowing so endpoint handlers
stay focused on prompt assembly and output parsing.
"""

from __future__ import annotations

from lectorium_chat.agent import llm
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)


async def run_oneshot(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.3,
    max_tokens: int = 256,
    log_label: str = "oneshot",
) -> str | None:
    """One-shot LLM call. Returns raw assistant content, or None on failure.

    Endpoint handlers should parse / validate / clean the returned text
    themselves — this helper deliberately doesn't impose structure so
    each callsite can shape its response as it needs.
    """
    try:
        resp = await llm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content or ""
    except Exception as exc:
        log.warning(f"{log_label}_llm_failed", error=str(exc))
        return None

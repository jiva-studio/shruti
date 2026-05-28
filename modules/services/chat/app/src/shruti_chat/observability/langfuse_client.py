"""Langfuse SDK integration — singleton client, prompt fetcher, callback factory.

Shruti uses a self-hosted Langfuse v3 instance (see plan
`distributed-stirring-riddle.md`, Phase 3). This module is the single
choke-point through which the rest of the chat service touches Langfuse:

- `init_langfuse(settings)` — lifespan-startup hook that builds the
  process-wide singleton. Reads `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY`
  / `LANGFUSE_SECRET_KEY` from the env. If any of those are unset OR
  `LANGFUSE_FORCE_FALLBACK=1`, no client is built — `get_langfuse()`
  returns None and every helper degrades to the local-file fallback so
  the service keeps serving traffic.

- `shutdown_langfuse()` — paired with init, called from the lifespan
  shutdown so the last batch of pending traces is flushed before the
  process exits. Without it ~1-2 seconds of traces are lost on every
  redeploy.

- `with_langfuse_trace(trace_id, user_id, session_id)` — async context
  manager that opens a root trace for one chat turn. Inside the body,
  `langfuse_node_callback(span_name)` returns a `CallbackHandler`
  bound to that same trace via `stateful_client=langfuse_singleton`
  — without that binding LangChain creates a SECOND trace per
  callback, splitting the per-turn tree into many disconnected pieces
  in the UI.

- `prompt_with_fallback(name, fallback)` — call sites that previously
  read a `.md` from disk now call this. On hit returns a
  `LangfusePromptHandle` (a thin wrapper exposing `.compile(**kwargs)`
  and `.config` so callers can read `prompt.config["model"]`). On miss
  (host unreachable, prompt not found, or `LANGFUSE_FORCE_FALLBACK=1`)
  returns a fallback handle that mimics the same surface. **Must be
  called inside per-turn functions, NOT at module import time** —
  caching it at import means we lose hot-reload entirely.

Eval / CI fast-path: `LANGFUSE_FORCE_FALLBACK=1` skips every network
call and returns fallback content immediately. This is how
`run_chunk_tools_eval.py` runs locally without a live Langfuse host.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


# Module-level singleton. Set in `init_langfuse`, cleared in
# `shutdown_langfuse`. Reads of this from worker code go through
# `get_langfuse()` so the None branch is explicit at every call site.
_LANGFUSE: Any | None = None


def _force_fallback() -> bool:
    """`LANGFUSE_FORCE_FALLBACK=1` short-circuits every Langfuse call —
    eval suite + local dev without a Langfuse host depend on this."""
    return os.environ.get("LANGFUSE_FORCE_FALLBACK", "").strip() in ("1", "true", "True")


def init_langfuse() -> None:
    """Build the process-wide Langfuse singleton from env vars. Idempotent.

    Called from FastAPI lifespan startup AFTER `setup_logging` so init
    failures appear as structured JSON logs in our standard pipeline.

    On any failure (missing env, import error, network) we LOG and
    continue — Langfuse is observability infrastructure, never on the
    critical path. The fallback branch keeps the service shipping.
    """
    global _LANGFUSE
    if _LANGFUSE is not None:
        return
    if _force_fallback():
        log.info("langfuse_disabled_force_fallback")
        return

    host = os.environ.get("LANGFUSE_HOST")
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if not (host and public_key and secret_key):
        log.info(
            "langfuse_disabled_missing_env",
            has_host=bool(host),
            has_public=bool(public_key),
            has_secret=bool(secret_key),
        )
        return

    try:
        from langfuse import Langfuse  # type: ignore
    except ImportError as exc:
        log.warning("langfuse_sdk_import_failed", error=str(exc))
        return

    # Environment label — surfaces in the Langfuse UI dropdown.
    # `SHRUTI_ENV` is the existing app-wide env name ("prod", "dev",
    # "staging"); fall back to "default" so nothing breaks if unset.
    environment = os.environ.get("SHRUTI_ENV") or os.environ.get(
        "LANGFUSE_TRACING_ENVIRONMENT") or "default"
    try:
        _LANGFUSE = Langfuse(
            host=host,
            public_key=public_key,
            secret_key=secret_key,
            environment=environment,
        )
        log.info("langfuse_initialised", host=host, environment=environment)
    except Exception as exc:  # noqa: BLE001
        log.warning("langfuse_init_failed", error=str(exc), host=host)
        _LANGFUSE = None


def shutdown_langfuse() -> None:
    """Flush pending traces and tear down the singleton. Called from
    FastAPI lifespan shutdown — without this, in-memory traces queued
    by the SDK background flusher are dropped on SIGTERM."""
    global _LANGFUSE
    client = _LANGFUSE
    if client is None:
        return
    try:
        client.shutdown()
        log.info("langfuse_shutdown_ok")
    except Exception as exc:  # noqa: BLE001
        log.warning("langfuse_shutdown_failed", error=str(exc))
    finally:
        _LANGFUSE = None


def get_langfuse() -> Any | None:
    """Module-private accessor — call sites should prefer the higher-level
    helpers (`prompt_with_fallback`, `langfuse_node_callback`) which
    handle the None branch internally."""
    return _LANGFUSE


def warm_prompt_cache(names: list[str]) -> None:
    """Eagerly fetch each prompt by name so the first chat-turn after
    boot doesn't pay the network round-trip on the hot path. Safe to
    call when the singleton is None — it short-circuits.

    Called from lifespan startup with the full list of prompt names
    Shruti uses (see `LANGFUSE_PROMPT_NAMES` below).
    """
    client = _LANGFUSE
    if client is None:
        return
    for name in names:
        try:
            client.get_prompt(name)
        except Exception as exc:  # noqa: BLE001
            # Missing prompt = bootstrap hasn't run yet, or version
            # mismatch. Not fatal — fallback kicks in at call time.
            log.info("langfuse_prompt_warmup_miss", prompt=name, error=str(exc))


# Canonical list of prompts the chat service expects in Langfuse. Used
# for warm-up at startup and as the source-of-truth for the bootstrap
# script (`scripts/bootstrap_langfuse_prompts.py`).
LANGFUSE_PROMPT_NAMES: tuple[str, ...] = (
    "query-planner",
    "synthesis-planner",
    "conclusion-writer",
    "topic-extractor",
    "caption-generator",
    "chat-router",
    "chat-section-header",
    "chat-section-tools",
    "chat-section-actions",
    "chat-section-followups",
    "chat-section-no_narration",
    "chat-section-citations",
    "chat-section-library",
    "chat-section-quoting",
    "chat-section-response_shape",
    "chat-section-language",
    "chat-section-safety",
)


# ── Prompt fetching with disk fallback ───────────────────────────────


@dataclass(frozen=True)
class LangfusePromptHandle:
    """Adapter wrapping either a real Langfuse `TextPromptClient` or a
    fallback (.md disk read) so call sites can use the same surface.

    - `text` — the prompt text. For Langfuse prompts this is the
      compiled form (variables substituted); for fallbacks it's the
      raw file content. Callers that need variables in the fallback
      path should format the string themselves before passing it in.
    - `config` — the JSON config attached to the prompt in Langfuse
      UI (`{"model": ..., "temperature": ...}`). Empty dict in
      fallback mode — callers that want per-prompt model overrides
      MUST handle the empty-config case.
    - `from_langfuse` — True if the text came from a live Langfuse
      fetch, False if it's a local-file fallback. Surfaced in logs
      so operators can spot when prompts are being served stale.
    """

    text: str
    config: dict[str, Any]
    from_langfuse: bool


def prompt_with_fallback(
    name: str,
    *,
    fallback: str | Callable[[], str],
    cache_ttl_seconds: int = 60,
) -> LangfusePromptHandle:
    """Fetch `name` from Langfuse; on miss, return the fallback.

    `fallback` may be a string (already-loaded text) or a callable
    returning the text. The callable form is for cases where the
    fallback is a disk read — we don't want to pay the I/O when
    Langfuse is healthy. The callable is invoked ONCE on miss.

    `cache_ttl_seconds=60` means a prompt edit in Langfuse UI
    propagates to running pods within a minute — fast enough for
    "hot-reload" workflows, slow enough to absorb a burst of get_prompt
    calls during a turn without thundering-herding the Langfuse API.
    """
    client = _LANGFUSE
    if client is None or _force_fallback():
        return _fallback_handle(fallback)

    try:
        prompt = client.get_prompt(name, cache_ttl_seconds=cache_ttl_seconds)
    except Exception as exc:  # noqa: BLE001
        log.warning("langfuse_get_prompt_failed", prompt=name, error=str(exc))
        return _fallback_handle(fallback)

    # `compile()` with no kwargs returns the prompt with no variable
    # substitution; equivalent to reading `.prompt`. Callers that need
    # variable substitution wrap this differently — see
    # `agent/prompts/__init__.py::build_prompt`.
    try:
        text = prompt.compile()
        config = prompt.config or {}
    except Exception as exc:  # noqa: BLE001
        log.warning("langfuse_prompt_compile_failed", prompt=name, error=str(exc))
        return _fallback_handle(fallback)

    return LangfusePromptHandle(text=text, config=config, from_langfuse=True)


def _fallback_handle(fallback: str | Callable[[], str]) -> LangfusePromptHandle:
    text = fallback() if callable(fallback) else fallback
    return LangfusePromptHandle(text=text, config={}, from_langfuse=False)


# ── Trace + callback helpers ──────────────────────────────────────────


@asynccontextmanager
async def with_langfuse_trace(
    trace_id: str,
    user_id: str | None,
    session_id: str | None,
    *,
    name: str = "chat_turn",
    input: Any | None = None,
    session_title: str | None = None,
) -> AsyncIterator[Any]:
    """Open a Langfuse root span for one chat turn (v3 OpenTelemetry API).

    Yields the root span so the caller can update it with the final
    output at end-of-turn:
        async with with_langfuse_trace(...) as span:
            ...
            if span is not None:
                span.update_trace(output=final_text)

    Nested LangChain CallbackHandlers (`langfuse_node_callback`) attach
    to this span automatically via OpenTelemetry context propagation —
    no explicit trace_id threading needed.
    """
    client = _LANGFUSE
    if client is None:
        yield None
        return
    try:
        # `trace_context` forces Langfuse to use OUR `trace_id` for the
        # OTel trace instead of generating its own — that way the value
        # the client sent in `X-Trace-Id` (the assistant message id,
        # hyphenless) IS the Langfuse trace_id, and a later
        # /chat/feedback POST with the same id lands on the right trace.
        # Root span carries the turn timing; trace-level input/output
        # are set EXPLICITLY below via `update_current_trace` because
        # Langfuse v3's "trace I/O mirrors root observation" behaviour
        # is unreliable when nested observations exist (issue #9556) —
        # child generations overwrite trace.input/output attributes.
        # Setting them on the trace directly survives those rewrites.
        with client.start_as_current_span(
            name=name,
            input=input,
            trace_context={"trace_id": trace_id},
        ) as span:
            try:
                trace_metadata: dict[str, Any] = {}
                if session_title:
                    trace_metadata["session_title"] = session_title
                client.update_current_trace(
                    name=name,
                    user_id=user_id,
                    session_id=session_id,
                    input=input,
                    metadata=trace_metadata or None,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("langfuse_trace_update_failed", error=str(exc))
            # Yield the span — caller does `update_current_trace(
            # output=...)` at end-of-turn before the with-block exits.
            yield span
    except Exception as exc:  # noqa: BLE001
        log.warning("langfuse_trace_open_failed", trace_id=trace_id, error=str(exc))
        yield None


def langfuse_node_callback(trace_id: str, span_name: str) -> Any | None:
    """Deprecated. Always returns None.

    Originally returned a LangChain `CallbackHandler` so node-level LLM
    calls could attach to the active trace. We removed it in favour of
    explicit `langfuse.start_as_current_observation(as_type="generation",
    ...)` wraps inside `infra/llm_provider/openrouter.py` because the
    handler:
      - emitted `type=span` instead of `type=generation` for inner
        ChatOpenAI calls in LangGraph-wrapped nodes (no model attribute,
        no usage_details, no cost),
      - produced unnamed nested children (`ChatOpenAI`, `RunnableLambda`)
        that cluttered the trace tree below our semantic `router_decision`
        / `query_planner` / `synthesizer` spans.

    The stub is retained so existing call sites that still build a
    `callbacks=[cb] if cb is not None else None` list don't need to be
    edited — they end up passing `callbacks=None` which is a no-op in
    the adapter.
    """
    del trace_id, span_name  # unused — see docstring
    return None

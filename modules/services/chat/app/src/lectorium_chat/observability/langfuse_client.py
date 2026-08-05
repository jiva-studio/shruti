"""Langfuse SDK integration — singleton client, prompt fetcher, callback factory.

Region-aware PII gating (#728): when a turn originates from the RU proxy
(`region="ru"`), `with_langfuse_trace` replaces the raw `user_id` with a
salted-sha256 hash so the Langfuse trace cannot be joined back to the
authenticated identity. The salt comes from `settings.langfuse_pii_salt`;
if unset, the user_id is sent through unchanged (test/dev convenience).
The `region` itself is always recorded on the trace metadata.

Lectorium uses a self-hosted Langfuse v3 instance (see plan
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

import hashlib
import os
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

from lectorium_chat.config import get_settings
from lectorium_chat.observability.logging import get_logger


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
    # `LECTORIUM_ENV` is the existing app-wide env name ("prod", "dev",
    # "staging"); fall back to "default" so nothing breaks if unset.
    environment = os.environ.get("LECTORIUM_ENV") or os.environ.get(
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


@contextmanager
def langfuse_span(name: str) -> Any:
    """Best-effort Langfuse span around a block, attaching to the active
    turn trace via OTel context propagation (no trace_id threading needed).

    Used to surface NON-LLM stages — retrieval (embed / pgvector fanout /
    rerank), per-thesis augmentation — in the trace timeline next to the LLM
    generations, so latency analysis sees where the un-instrumented seconds
    go. No-op (yields None) when Langfuse is disabled or span creation fails;
    the wrapped block always runs. Safe across `await` — the span stays
    current within the task, so nested generations nest under it.
    """
    client = _LANGFUSE
    span_cm = None
    if client is not None:
        try:
            span_cm = client.start_as_current_span(name=name)
        except Exception as exc:  # noqa: BLE001 — telemetry never breaks a turn
            log.warning("langfuse_span_open_failed", name=name, error=str(exc))
            span_cm = None
    if span_cm is None:
        yield None
        return
    with span_cm as span:
        yield span


def warm_prompt_cache(names: list[str]) -> None:
    """Eagerly fetch each prompt by name so the first chat-turn after
    boot doesn't pay the network round-trip on the hot path. Safe to
    call when the singleton is None — it short-circuits.

    Called from lifespan startup with the full list of prompt names
    Lectorium uses (see `LANGFUSE_PROMPT_NAMES` below).
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
# The warm-up list lives with the prompt registry (the same table the
# bootstrap script publishes from). NOT re-exported from here: importing it
# would pull in `agent/prompts/__init__`, which imports `prompt_with_fallback`
# back out of this module — a cycle that only breaks under some import orders.
# Callers take it from `agent.prompts.registry` directly.


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


def _hash_user_id_for_region(user_id: str | None) -> str | None:
    """Salted-sha256 hash of `user_id` for RU-region traces.

    The salt comes from settings; if absent we DROP the user_id (return
    None) rather than leaking the raw id under a defended-PII flag. The
    startup warning in `warn_if_pii_salt_unset` ensures the operator
    sees this in prod logs at boot — no silent fall-through to raw-PII
    persistence. Truncated to 16 hex chars — enough entropy to
    distinguish users in a single corpus, short enough to keep the
    Langfuse UI readable.
    """
    if user_id is None:
        return None
    salt = get_settings().langfuse_pii_salt
    if not salt:
        return None
    digest = hashlib.sha256(f"{salt}:{user_id}".encode()).hexdigest()
    return digest[:16]


def warn_if_pii_salt_unset() -> None:
    """Emit a critical warning at startup if the PII salt is missing in
    a production-class environment.

    Called from FastAPI lifespan startup. In `prod` / `staging`, missing
    `LANGFUSE_PII_SALT` means every RU-region trace will have its
    `user_id` dropped to None (see `_hash_user_id_for_region`) — that is
    safer than the previous silent-leak behaviour, but it also means RU
    traces lose their per-user attribution. Operators need to know.
    """
    s = get_settings()
    if s.env in {"prod", "staging"} and not s.langfuse_pii_salt:
        log.warning(
            "langfuse_pii_salt_unset",
            env=s.env,
            consequence="RU-region user_id will be dropped from Langfuse traces",
        )


@asynccontextmanager
async def with_langfuse_trace(
    trace_id: str,
    user_id: str | None,
    session_id: str | None,
    *,
    name: str = "chat_turn",
    input: Any | None = None,
    session_title: str | None = None,
    region: str | None = None,
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
                trace_metadata: dict[str, Any] = {"region": region}
                if session_title:
                    trace_metadata["session_title"] = session_title
                effective_user_id = (
                    _hash_user_id_for_region(user_id) if region == "ru" else user_id
                )
                client.update_current_trace(
                    name=name,
                    user_id=effective_user_id,
                    session_id=session_id,
                    input=input,
                    metadata=trace_metadata,
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

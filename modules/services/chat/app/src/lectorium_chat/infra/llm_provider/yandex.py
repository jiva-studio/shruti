"""YandexGPT 5 LLMPort adapter.

Talks directly to the Yandex Cloud Foundation Models REST API. We don't
go through `langchain_openai.ChatOpenAI` (as we do for OpenRouter)
because Yandex's wire format is not OpenAI-shaped — the streaming
protocol is newline-delimited JSON over chunked HTTP rather than SSE,
and each chunk carries the FULL cumulative text instead of a delta,
which means an adapter has to do delta extraction before yielding.

Auth: Api-Key (`Authorization: Api-Key <key>`) OR IAM token
(`Authorization: Bearer <iam>`). YANDEX_GPT_FOLDER_ID is always
required — it's part of the `gpt://<folder>/<model>/<version>` model
URI and is also sent in `x-folder-id`.

Tool / function calling is intentionally NOT implemented yet — the
chat graph's research worker uses tools heavily and YandexGPT 5 exposes
a tool format that's close to OpenAI but not identical. Calls that
arrive with `tools=` raise `NotImplementedError` so the caller can
either route through OpenRouter on global or surface the gap loudly
during Russia VPS bring-up. Tracked for a follow-up PR.

Structured-output: Yandex has no native JSON-schema mode (yet). The
adapter falls back to "collect the streamed text, strip ```json fences,
parse, validate". All chat callsites today (router, topic-extract,
caption) hit short, well-prompted schemas, so this is acceptable. If
a callsite needs hard JSON-schema enforcement, it should route through
OpenRouter on global until Yandex grows the feature.
"""

from __future__ import annotations

import asyncio
import json
import random
from contextlib import asynccontextmanager, nullcontext
from typing import Any, AsyncIterator, TypeVar

import httpx
from pydantic import BaseModel

from lectorium_chat.config import Settings
from lectorium_chat.domain.entities import CompletionChunk, Message
from lectorium_chat.observability.langfuse_client import get_langfuse
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)

T = TypeVar("T", bound=BaseModel)


# REST endpoint for chat-style completions. There is also a gRPC-only
# Foundation Models surface, but the REST one is wire-stable and we
# avoid pulling in grpcio + protobuf for a single endpoint.
_YANDEX_COMPLETION_URL = (
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion"
)

# Bounded retry on HTTP 429 (Too Many Requests) for the initial POST.
# Yandex's Foundation Models RPS quota on a fresh folder is ~3-5/s;
# the chat service today fires one stream at a time, but parallel
# callers (e.g. background outline generation + a live chat turn)
# can still trip 429. Mid-stream failures are NOT retried — once
# the stream is open we have token/usage state mid-flight and the
# caller already committed to consuming a delta sequence.
_MAX_RETRIES = 5
_BACKOFF_BASE_SECONDS = 2.0


def _retry_delay(attempt: int, retry_after: str | None) -> float:
    """Compute the sleep before the next retry on 429.

    Honours `Retry-After` (RFC 7231 — seconds form). Falls back to
    exponential backoff with jitter to spread concurrent retries.
    """
    if retry_after:
        try:
            return max(float(retry_after), 0.0)
        except ValueError:
            pass
    return _BACKOFF_BASE_SECONDS * (2 ** attempt) + random.random()


class YandexLLMProvider:
    """`LLMPort` impl backed by the Yandex Cloud Foundation Models REST API.

    One adapter instance owns one `httpx.AsyncClient` — the connection
    pool survives across calls, matching the OpenRouter adapter's
    behaviour (where `langchain_openai.ChatOpenAI` keeps its own pool).

    Lifecycle: build at composition root, call `close()` from the
    FastAPI lifespan shutdown handler. The class is otherwise stateless
    and async-safe.
    """

    def __init__(
        self, settings: Settings, *, concurrency: int = 2,
    ) -> None:
        if not settings.yandex_gpt_folder_id:
            raise RuntimeError(
                "YandexLLMProvider requires YANDEX_GPT_FOLDER_ID in settings"
            )
        if not settings.yandex_gpt_api_key and not settings.yandex_iam_token:
            raise RuntimeError(
                "YandexLLMProvider requires YANDEX_GPT_API_KEY or "
                "YANDEX_IAM_TOKEN in settings"
            )
        self._settings = settings
        self._folder = settings.yandex_gpt_folder_id
        self._auth_header = self._resolve_auth(settings)
        self._default_model = settings.llm_default
        # Same timeout shape as OpenRouter's 180s upper bound — long
        # research turns + Russia network latency need headroom.
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=10.0, read=180.0, write=30.0, pool=10.0
            ),
        )
        # Bound parallelism on outgoing requests. We don't fan out
        # chat completions today, but the semaphore is a cheap guard
        # against a future caller spinning multiple streams in parallel
        # (e.g. background outline generator + a live chat turn) and
        # tripping the Foundation Models RPS quota.
        self._sem = asyncio.Semaphore(concurrency)

    @staticmethod
    def _resolve_auth(s: Settings) -> str:
        # Api-Key path is the simpler one — long-lived, no refresh.
        # IAM path requires the host to keep the token fresh externally
        # (e.g. `yc iam create-token` cron); we just read it here.
        if s.yandex_gpt_api_key:
            return f"Api-Key {s.yandex_gpt_api_key}"
        if s.yandex_iam_token:
            return f"Bearer {s.yandex_iam_token}"
        # Already enforced in __init__ + config validator; defensive.
        raise RuntimeError(
            "no yandex credentials — set YANDEX_GPT_API_KEY or YANDEX_IAM_TOKEN"
        )

    def _build_model_uri(self, model: str) -> str:
        """Convert a bare model name → full `gpt://...` URI.

        Accepts either:
          * `gpt://b1.../yandexgpt-lite/latest` (pass-through)
          * `yandexgpt-lite/latest` (we prepend `gpt://<folder>/`)
          * a LiteLLM-shaped `yandex/yandexgpt-lite/latest` (legacy from
            the litellm shim — strip the prefix and prepend folder)
        """
        if model.startswith("gpt://"):
            return model
        bare = model.removeprefix("yandex/")
        return f"gpt://{self._folder}/{bare}"

    @staticmethod
    def _to_yandex_message(m: Message) -> dict[str, str]:
        # Yandex uses {"role": ..., "text": ...} where role is one of
        # {system, user, assistant}. Tool messages don't have a Yandex
        # analogue — the caller shouldn't be sending them given tools
        # are NotImplementedError'd below, but if one slips through we
        # downgrade it to a system message so the request still parses.
        role = m["role"]
        if role == "tool":
            return {"role": "system", "text": m["content"]}
        return {"role": role, "text": m["content"]}

    @staticmethod
    def _generation_ctx(
        *,
        name: str | None,
        model: str,
        messages: list[Message],
        model_parameters: dict[str, Any] | None,
    ) -> Any:
        """Open a Langfuse `generation` observation around one LLM call.

        Same idea as `OpenRouterLLMProvider._generation_ctx` — we register
        each call as a typed generation so the Langfuse UI shows model /
        cost / usage. nullcontext when Langfuse is not configured.
        """
        lf = get_langfuse()
        if lf is None:
            return nullcontext(None)
        try:
            return lf.start_as_current_observation(
                as_type="generation",
                name=name or "llm_call",
                model=model,
                input=messages,
                model_parameters=model_parameters or None,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("langfuse_generation_open_failed", error=str(exc))
            return nullcontext(None)

    @asynccontextmanager
    async def _stream_with_retry_on_429(
        self,
        *,
        body: dict[str, Any],
        headers: dict[str, str],
        model_uri: str,
    ) -> AsyncIterator[httpx.Response]:
        """Open `client.stream(POST, ...)` with bounded retry on 429.

        Yielded value is the live `httpx.Response`. Caller is responsible
        for `raise_for_status()` and consuming the body — we just handle
        the throttle handshake. Non-429 status codes (including 4xx like
        401/400 and all 5xx) pass through unchanged for the caller to
        raise normally.

        Body content is NOT consumed on a 429 attempt — we read the
        Retry-After header off the response head, close the stream, and
        retry. Streaming bodies on error responses are typically a JSON
        error dict; not reading them keeps the retry path cheap.
        """
        last_resp_status: int | None = None
        last_retry_after: str | None = None
        for attempt in range(_MAX_RETRIES + 1):
            stream_cm = self._client.stream(
                "POST", _YANDEX_COMPLETION_URL, json=body, headers=headers,
            )
            resp = await stream_cm.__aenter__()
            if resp.status_code != 429:
                try:
                    yield resp
                    return
                finally:
                    await stream_cm.__aexit__(None, None, None)
            # 429 path — close immediately and either retry or give up.
            last_resp_status = resp.status_code
            last_retry_after = resp.headers.get("Retry-After")
            await stream_cm.__aexit__(None, None, None)
            if attempt >= _MAX_RETRIES:
                log.error(
                    "yandex_llm_throttled_giving_up",
                    model_uri=model_uri,
                    attempts=attempt + 1,
                    retry_after=last_retry_after,
                )
                # Re-open one final time so the caller's raise_for_status
                # surfaces the 429 with the original response context
                # (headers, body) intact — matches the pre-retry contract.
                final_cm = self._client.stream(
                    "POST", _YANDEX_COMPLETION_URL, json=body, headers=headers,
                )
                final_resp = await final_cm.__aenter__()
                try:
                    yield final_resp
                    return
                finally:
                    await final_cm.__aexit__(None, None, None)
            delay = _retry_delay(attempt, last_retry_after)
            log.warning(
                "yandex_llm_throttled_retrying",
                model_uri=model_uri,
                attempt=attempt + 1,
                max_attempts=_MAX_RETRIES + 1,
                sleep_seconds=round(delay, 2),
                retry_after=last_retry_after,
            )
            await asyncio.sleep(delay)
        # Defensive — loop always returns or re-yields above.
        raise RuntimeError(  # pragma: no cover
            f"YandexLLMProvider: retry loop exited without resolution "
            f"(last status={last_resp_status})"
        )

    async def stream_completion(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> AsyncIterator[CompletionChunk]:
        if tools:
            # See module docstring — tool format diverges and the chat
            # graph relies on the OpenAI shape. Defer until we have a
            # Yandex-shape adapter for tool schemas.
            raise NotImplementedError(
                "YandexLLMProvider: function calling not yet implemented. "
                "Route tool-using paths through OpenRouter or wait for the "
                "next iteration."
            )
        chosen_model = model or self._default_model
        model_uri = self._build_model_uri(chosen_model)
        body: dict[str, Any] = {
            "modelUri": model_uri,
            "completionOptions": {
                "stream": True,
                # Yandex's REST API expects `maxTokens` as a string —
                # this is per their schema (int64 wire format), passing
                # an int sometimes succeeds, sometimes 400s.
                "maxTokens": "2000",
            },
            "messages": [self._to_yandex_message(m) for m in messages],
        }
        if temperature is not None:
            body["completionOptions"]["temperature"] = temperature
        headers = {
            "Authorization": self._auth_header,
            "x-folder-id": self._folder,
            "Content-Type": "application/json",
        }
        gen_ctx = self._generation_ctx(
            name=run_name,
            model=model_uri,
            messages=messages,
            model_parameters=(
                {"temperature": temperature} if temperature is not None else None
            ),
        )
        # Yandex sends CUMULATIVE text — every chunk repeats the full
        # output-so-far. Track the previous text so we yield deltas to
        # the caller (which then forwards them through MarkerExpander
        # to the client without dedup logic).
        prev_text = ""
        text_acc: list[str] = []
        usage_in = 0
        usage_out = 0
        with gen_ctx as gen:
            try:
                # Bound concurrent open streams — protects the per-folder
                # RPS quota when multiple call sites stream in parallel.
                # Held for the full stream duration: Yandex's quota is
                # really about concurrent active completions, not just
                # request opens.
                async with self._sem, self._stream_with_retry_on_429(
                    body=body, headers=headers, model_uri=model_uri,
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            log.warning(
                                "yandex_malformed_chunk", line_prefix=line[:200],
                            )
                            continue
                        result = obj.get("result") or {}
                        alternatives = result.get("alternatives") or [{}]
                        alt = alternatives[0]
                        msg_text = (alt.get("message") or {}).get("text", "")
                        status = alt.get("status", "")
                        # Cumulative → delta. If a chunk somehow does
                        # NOT start with prev_text (corruption / restart
                        # mid-stream), fall back to yielding the whole
                        # text — the consumer dedups by character but
                        # this case should not occur in practice.
                        if msg_text.startswith(prev_text):
                            delta = msg_text[len(prev_text):]
                        else:
                            delta = msg_text
                        prev_text = msg_text
                        chunk: CompletionChunk = {}
                        if delta:
                            chunk["text"] = delta
                            text_acc.append(delta)
                        usage = result.get("usage")
                        if usage is not None:
                            # `inputTextTokens` / `completionTokens` are
                            # int64 strings per the API spec.
                            try:
                                usage_in = int(usage.get("inputTextTokens", 0))
                                usage_out = int(usage.get("completionTokens", 0))
                            except (TypeError, ValueError):
                                pass
                            chunk["prompt_tokens"] = usage_in
                            chunk["completion_tokens"] = usage_out
                        if status == "ALTERNATIVE_STATUS_FINAL":
                            chunk["finish_reason"] = "stop"
                        elif status == "ALTERNATIVE_STATUS_TRUNCATED_FINAL":
                            chunk["finish_reason"] = "length"
                        if chunk:
                            yield chunk
            finally:
                if gen is not None:
                    try:
                        gen.update(
                            output={"text": "".join(text_acc)},
                            usage_details={"input": usage_in, "output": usage_out},
                        )
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "langfuse_generation_update_failed", error=str(exc),
                        )

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T:
        """Best-effort JSON-mode fallback.

        Yandex has no native schema-enforced output. We tack a strong
        "respond with JSON matching schema X" instruction onto the
        conversation, stream the result, strip ```json fences, parse,
        validate. If parsing or validation fails the caller sees a
        RuntimeError — same loud surface OpenRouter would give on a
        schema mismatch.
        """
        # Prepend a system reminder; the caller's existing system
        # prompt already covers the *task*, this just hardens the output
        # format. Schema dump is the JSON Schema view (BaseModel.model_json_schema).
        schema_json = json.dumps(schema.model_json_schema())
        guided_messages: list[Message] = list(messages)
        guided_messages.append(
            {
                "role": "system",
                "content": (
                    "Respond with a single JSON object matching this JSON Schema. "
                    "Do not include any prose, code fences, or commentary. "
                    f"Schema: {schema_json}"
                ),
            }
        )
        # temperature=0 mirrors OpenRouter — deterministic JSON, no
        # surprise wording flips between calls.
        out = ""
        async for chunk in self.stream_completion(
            guided_messages,
            model=model,
            temperature=0.0,
            run_name=run_name,
        ):
            out += chunk.get("text", "")
        cleaned = out.strip()
        if cleaned.startswith("```"):
            # Common LLM-emitted fenced block: ```json ... ``` or ``` ... ```.
            cleaned = cleaned.removeprefix("```json").removeprefix("```").strip()
            if cleaned.endswith("```"):
                cleaned = cleaned.removesuffix("```").strip()
        try:
            obj = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"YandexLLMProvider.structured_output: model returned "
                f"non-JSON output for schema {schema.__name__}: {exc}"
            ) from exc
        return schema.model_validate(obj)

    async def close(self) -> None:
        await self._client.aclose()

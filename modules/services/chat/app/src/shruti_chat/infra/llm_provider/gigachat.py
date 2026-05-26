"""GigaChat (Sber) LLMPort adapter.

GigaChat's chat-completions endpoint is OpenAI-shaped, so the
request/response plumbing here mirrors `OpenRouterLLMProvider` closely.
The two differences are auth (OAuth2 client-credentials with a
short-lived token instead of a static API key) and the function-call
shape on streamed deltas (`delta.function_call.{name,arguments}`
following OpenAI's *legacy* shape rather than the newer
`delta.tool_calls[]` form).

Auth flow:
1. POST to `ngw.devices.sberbank.ru:9443/api/v2/oauth` with
   `Authorization: Basic base64(client_id:client_secret)` and a
   `scope` form param (`GIGACHAT_API_PERS` / `_B2B` / `_CORP`).
2. Server returns `{"access_token": "...", "expires_at": <unix_ms>}`.
3. Cache the token, refresh ~30s before expiry. Locked behind an
   `asyncio.Lock` so concurrent in-flight calls don't all fetch.

TLS: GigaChat uses the Russian Trusted Root CA chain. Operators must
mount the cert and point `GIGACHAT_CA_PATH` at it. If unset we fall
back to httpx's default trust store — dev / CI works, prod will fail
with an SSL verification error which is the correct loud failure mode.
We do NOT silently disable verification.
"""

from __future__ import annotations

import asyncio
import base64
import json
import ssl
import time
import uuid
from contextlib import nullcontext
from typing import Any, AsyncIterator, TypeVar

import httpx
from pydantic import BaseModel

from shruti_chat.config import Settings
from shruti_chat.domain.entities import CompletionChunk, Message, ToolCallDelta
from shruti_chat.observability.langfuse_client import get_langfuse
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)

T = TypeVar("T", bound=BaseModel)


_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
_COMPLETION_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions"


class _GigachatAuthCache:
    """Caches the OAuth2 access token; refreshes ~30s before expiry.

    Concurrent callers hit one `asyncio.Lock` on refresh so we don't
    burn N parallel requests against the auth endpoint when the cache
    expires mid-burst. The double-checked-locking pattern (check
    expiry → acquire → re-check) handles the race where two coroutines
    pass the first check before either acquires the lock.
    """

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        scope: str,
        http: httpx.AsyncClient,
    ) -> None:
        self._basic = base64.b64encode(
            f"{client_id}:{client_secret}".encode()
        ).decode()
        self._scope = scope
        self._http = http
        self._token: str | None = None
        # Unix seconds (float) — the API returns expires_at in unix ms.
        self._exp: float = 0.0
        self._lock = asyncio.Lock()

    async def token(self) -> str:
        now = time.time()
        if self._token and now < self._exp - 30:
            return self._token
        async with self._lock:
            now = time.time()
            if self._token and now < self._exp - 30:
                return self._token
            resp = await self._http.post(
                _AUTH_URL,
                headers={
                    "Authorization": f"Basic {self._basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                    # RqUID is a required correlation header on Sber's
                    # auth endpoint — must be a fresh UUID per request.
                    "RqUID": str(uuid.uuid4()),
                },
                data={"scope": self._scope},
            )
            resp.raise_for_status()
            body = resp.json()
            access = body.get("access_token")
            exp_ms = body.get("expires_at")
            if not access or exp_ms is None:
                raise RuntimeError(
                    "gigachat: auth response missing access_token / expires_at"
                )
            self._token = access
            # expires_at is unix milliseconds — convert to seconds.
            self._exp = float(exp_ms) / 1000.0
            return self._token


class GigaChatLLMProvider:
    """`LLMPort` impl backed by Sber GigaChat's REST API.

    Owns one `httpx.AsyncClient` for both auth and completions; the
    auth client SHARES this pool so OAuth refreshes ride the same
    connection as completions when possible. Same lifecycle pattern as
    `YandexLLMProvider` — build at composition root, `close()` from
    lifespan shutdown.
    """

    def __init__(self, settings: Settings) -> None:
        if not settings.gigachat_client_id or not settings.gigachat_client_secret:
            raise RuntimeError(
                "GigaChatLLMProvider requires GIGACHAT_CLIENT_ID and "
                "GIGACHAT_CLIENT_SECRET in settings"
            )
        self._settings = settings
        # Build a verify-context out of the configured CA path. If
        # nothing is configured, fall back to system trust — dev works
        # via the public Sber chain when a node-level CA bundle is
        # installed; prod must mount the explicit Russian Trusted CA
        # via GIGACHAT_CA_PATH.
        if settings.gigachat_ca_path:
            verify: ssl.SSLContext | bool = ssl.create_default_context(
                cafile=settings.gigachat_ca_path,
            )
        else:
            verify = True
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=10.0, read=180.0, write=30.0, pool=10.0,
            ),
            verify=verify,
        )
        self._auth = _GigachatAuthCache(
            client_id=settings.gigachat_client_id,
            client_secret=settings.gigachat_client_secret,
            scope=settings.gigachat_scope,
            http=self._http,
        )
        self._default_model = settings.llm_default

    @staticmethod
    def _to_gigachat_message(m: Message) -> dict[str, Any]:
        # GigaChat speaks OpenAI's chat-completion message format —
        # role + content + (optional) tool_call_id + tool_calls. We
        # pass them through verbatim; the only thing not propagated is
        # any unknown extra TypedDict key, since `Message` is total=False
        # and the producer never adds undocumented keys.
        out: dict[str, Any] = {"role": m["role"], "content": m["content"]}
        if "tool_call_id" in m:
            out["tool_call_id"] = m["tool_call_id"]
        if "tool_calls" in m:
            out["tool_calls"] = m["tool_calls"]
        return out

    @staticmethod
    def _normalise_model(model: str) -> str:
        # The legacy litellm-shim shape `gigachat/GigaChat-Pro` should
        # collapse to the bare provider name.
        return model.removeprefix("gigachat/")

    @staticmethod
    def _generation_ctx(
        *,
        name: str | None,
        model: str,
        messages: list[Message],
        model_parameters: dict[str, Any] | None,
    ) -> Any:
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
        chosen_model = self._normalise_model(model or self._default_model)
        body: dict[str, Any] = {
            "model": chosen_model,
            "messages": [self._to_gigachat_message(m) for m in messages],
            "stream": True,
        }
        if temperature is not None:
            body["temperature"] = temperature
        if tools:
            # GigaChat's tool surface is the OpenAI *legacy* `functions`
            # field, NOT the newer `tools` field. The wire payload of
            # each entry already matches the FunctionDefinition shape
            # the chat graph emits (name + description + parameters),
            # so we just rename the top-level key. tool_choice maps to
            # `function_call`.
            body["functions"] = [t.get("function", t) for t in tools]
            if tool_choice in ("auto", "none"):
                body["function_call"] = tool_choice
            elif isinstance(tool_choice, str) and tool_choice not in ("required",):
                # Specific tool name → {"name": "..."}
                body["function_call"] = {"name": tool_choice}

        gen_ctx = self._generation_ctx(
            name=run_name,
            model=chosen_model,
            messages=messages,
            model_parameters=(
                {"temperature": temperature} if temperature is not None else None
            ),
        )
        text_acc: list[str] = []
        tool_call_acc: list[dict[str, Any]] = []
        usage_in = 0
        usage_out = 0
        with gen_ctx as gen:
            try:
                token = await self._auth.token()
                async with self._http.stream(
                    "POST",
                    _COMPLETION_URL,
                    json=body,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream",
                    },
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = json.loads(data)
                        except json.JSONDecodeError:
                            log.warning(
                                "gigachat_malformed_chunk",
                                data_prefix=data[:200],
                            )
                            continue
                        choices = obj.get("choices") or [{}]
                        choice = choices[0]
                        delta = choice.get("delta") or {}
                        chunk: CompletionChunk = {}
                        if (text := delta.get("content")):
                            chunk["text"] = text
                            text_acc.append(text)
                        # Legacy function_call shape: each chunk carries
                        # a `function_call.name` (first chunk) or
                        # `function_call.arguments` (subsequent chunks
                        # streaming JSON arguments). We synthesise a
                        # single-index ToolCallDelta so downstream
                        # consumers (react_loop's tool-call buffer)
                        # accumulate it correctly.
                        if (fn := delta.get("function_call")):
                            tcd: ToolCallDelta = {"index": 0}
                            if (n := fn.get("name")):
                                tcd["name"] = n
                                # First chunk of a call carries the
                                # name AND the id is implicit — mint one.
                                tcd["id"] = f"gigachat-{uuid.uuid4().hex[:12]}"
                            if (a := fn.get("arguments")) is not None:
                                tcd["arguments_delta"] = a
                            chunk["tool_calls"] = [tcd]
                            tool_call_acc.append(dict(tcd))
                        if (fr := choice.get("finish_reason")):
                            chunk["finish_reason"] = fr
                        usage = obj.get("usage")
                        if usage is not None:
                            usage_in = int(usage.get("prompt_tokens", usage_in))
                            usage_out = int(
                                usage.get("completion_tokens", usage_out)
                            )
                            chunk["prompt_tokens"] = usage_in
                            chunk["completion_tokens"] = usage_out
                        if chunk:
                            yield chunk
            finally:
                if gen is not None:
                    try:
                        gen_output: dict[str, Any] = {"text": "".join(text_acc)}
                        if tool_call_acc:
                            gen_output["tool_calls"] = tool_call_acc
                        gen.update(
                            output=gen_output,
                            usage_details={
                                "input": usage_in, "output": usage_out,
                            },
                        )
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "langfuse_generation_update_failed",
                            error=str(exc),
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

        GigaChat has a `response_format={"type":"json_object"}` flag on
        some models, but it's not universal across the Lite/Pro/Max
        tier and unrelated to JSON-schema enforcement. We use the
        same "ask for JSON in the prompt, parse, validate" recipe as
        the Yandex adapter — keeps semantics consistent and removes a
        tier-conditional branch from this code path.
        """
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
            cleaned = cleaned.removeprefix("```json").removeprefix("```").strip()
            if cleaned.endswith("```"):
                cleaned = cleaned.removesuffix("```").strip()
        try:
            obj = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"GigaChatLLMProvider.structured_output: model returned "
                f"non-JSON output for schema {schema.__name__}: {exc}"
            ) from exc
        return schema.model_validate(obj)

    async def close(self) -> None:
        await self._http.aclose()

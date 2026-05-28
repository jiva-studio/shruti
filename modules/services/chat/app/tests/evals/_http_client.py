"""HTTP-backed observe_turn for running the eval against a deployed chat.

Talks to a live chat instance over HTTPS+SSE — used for prod regression
eval without spinning up the local Postgres / OpenRouter / S3 stack
that the in-process `EvalChatClient` requires.

Kept in its own module (no imports of `shruti_chat.*`) so the
runner can pick this pathway via `EVAL_TARGET_URL=...` without
incidentally constructing all the local infra fixtures.

What this CAN capture from the SSE wire:
  - response_text (concatenated `delta` events post-marker-expansion)
  - intent (from `status` event with `key=router_decision`)

What this CANNOT capture (not surfaced over SSE on purpose):
  - tool_chain — server-side only; tool-based predicates skip silently
  - outline.n_theses / has_conclusion / skipped_notes_ratio —
    `outline_summary` event is swallowed by `chat_turn` before reaching
    the client. Outline-shape predicates skip silently when None.

For full predicate coverage (tool / outline) use the in-process
EvalChatClient against a local DB.
"""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Any

from tests.evals.observation import TurnObservation


class HttpChatClient:
    def __init__(self, base_url: str) -> None:
        self._base = base_url.rstrip("/")

    async def observe_turn(
        self, query: str, context: dict[str, Any] | None = None,
        *, lang: str = "ru",
    ) -> TurnObservation:
        # Fresh device_id per turn — each case gets its own anonymous
        # user so per-user rate limits don't cascade. IP-level limits
        # still apply (one machine = one IP), but those are 2000/day.
        device_id = f"eval-{time.time_ns()}"
        token_req = urllib.request.Request(
            f"{self._base}/auth/anonymous",
            data=json.dumps({"deviceId": device_id}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(token_req, timeout=10) as r:
            token = json.loads(r.read())["accessToken"]

        chat_req = urllib.request.Request(
            f"{self._base}/chat",
            data=json.dumps({
                "messages": [{"role": "user", "content": query}],
                "lang": lang,
            }).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "X-Chat-Protocol-Version": "1",
            },
        )

        intent: str | None = None
        deltas: list[str] = []
        with urllib.request.urlopen(chat_req, timeout=120) as r:
            ev: str | None = None
            for raw in r:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line.startswith("event: "):
                    ev = line[7:]
                elif line.startswith("data: "):
                    try:
                        payload = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    if ev == "delta":
                        deltas.append(payload.get("text", ""))
                    elif ev == "status":
                        if payload.get("key") == "router_decision":
                            params = payload.get("params") or {}
                            maybe = params.get("intent")
                            if isinstance(maybe, str):
                                intent = maybe
                # SSE message boundary — reset event name on blank line.
                if line == "":
                    ev = None

        return TurnObservation(
            intent=intent,
            response_text="".join(deltas),
        )

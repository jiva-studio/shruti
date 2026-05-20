"""One-shot smoke test: run a single query through the live eval
fixture. Use this to verify the wiring before paying for the full
eval pass.

    python -m tests.evals._smoke_one "привет"
"""

from __future__ import annotations

import asyncio
import sys

from tests.evals._fixtures import make_chat_client


async def _main(query: str) -> int:
    client = make_chat_client()
    obs = await client.observe_turn(query)
    print(f"query: {query!r}")
    print(f"intent: {obs.intent} (confidence={obs.confidence})")
    print(f"tool_chain: {obs.tool_names}")
    print(f"response ({len(obs.response_text)} chars):")
    print(obs.response_text or "(empty)")
    return 0


if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "привет"
    raise SystemExit(asyncio.run(_main(q)))

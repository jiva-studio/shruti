#!/usr/bin/env python3
"""bench_replay.py — fixed-corpus latency benchmark for /chat.

Sends a deterministic set of queries (covering every intent) against
the chat service, then aggregates the `stage_timing` events that the
service emits on stdout. Runs the same set twice (cold + warm) so the
"after Redis cache" comparison shows both the L2-miss and L2-hit
shapes.

Usage:
    SERVER_URL=https://<your-host> \
    APP_TOKEN=<your app token> \
    python scripts/bench_replay.py

The script does NOT read logs from the server. It only collects each
turn's `turn_total_ms` from the SSE `done` event timing measured at the
client (wall-clock from POST → terminal `done`). For per-stage
breakdown, pull `stage_timing` log lines from the server separately
(see deploy.sh logs hint) and aggregate with the same `jq`-based
pipeline used for the Stage 1 baseline.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Iterable

import httpx


# 30 queries × ~5 per intent. Picked from real Stage 1 prod logs so the
# distribution mirrors actual usage; the SHORT/LONG split inside the
# `research` group is driven by whether the curated question-attribution
# corpus has a match (we can't know that here — both paths get exercised
# by the natural spread).
_QUERIES: list[tuple[str, str, str]] = [
    # (intent_label, lang, message)
    ("research_ru",       "ru", "Что такое душа?"),
    ("research_ru",       "ru", "Что такое майя?"),
    ("research_ru",       "ru", "Расскажи про реинкарнацию"),
    ("research_ru",       "ru", "Как контролировать ум?"),
    ("research_ru",       "ru", "Что такое гуны материальной природы?"),
    ("research_ru",       "ru", "Как стать преданным Кришны?"),
    ("research_ru",       "ru", "Что значит сознание Кришны?"),
    ("research_ru",       "ru", "Что говорит Прабхупада о карме?"),
    ("research_en",       "en", "What is bhakti linux-client?"),
    ("research_en",       "en", "What does Krishna say about devotion?"),
    ("research_en",       "en", "How to chant Hare Krishna mantra?"),
    ("research_en",       "en", "What is the soul?"),
    ("find_track_ru",     "ru", "Найди утреннюю прогулку 1976 года"),
    ("find_track_ru",     "ru", "Найди лекцию о буддхи-йоге"),
    ("find_track_en",     "en", "Find a lecture about humility"),
    ("direct_chat_ru",    "ru", "Привет"),
    ("direct_chat_ru",    "ru", "Спасибо!"),
    ("direct_chat_ru",    "ru", "Как дела?"),
    ("direct_chat_en",    "en", "Thank you"),
    ("help_ru",           "ru", "Как пользоваться приложением?"),
    ("help_en",           "en", "How does this app work?"),
]


@dataclass
class TurnResult:
    intent_label: str
    elapsed_ms: float
    bytes_received: int
    error: str | None = None


async def one_turn(
    client: httpx.AsyncClient,
    base_url: str,
    token: str,
    intent_label: str,
    lang: str,
    message: str,
) -> TurnResult:
    headers = {
        "Content-Type": "application/json",
        "X-App-Token": token,
        "X-Device-Id": f"bench-{uuid.uuid4()}",
        "X-Chat-Protocol-Version": "1",
        "Accept": "text/event-stream",
    }
    payload = {
        "messages": [{"role": "user", "content": message}],
        "lang": lang,
    }
    started = time.perf_counter()
    bytes_received = 0
    try:
        async with client.stream(
            "POST", f"{base_url}/chat", json=payload, headers=headers,
            timeout=httpx.Timeout(60.0, connect=10.0),
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                return TurnResult(
                    intent_label=intent_label,
                    elapsed_ms=(time.perf_counter() - started) * 1000,
                    bytes_received=len(body),
                    error=f"HTTP {resp.status_code}: {body[:120]!r}",
                )
            async for chunk in resp.aiter_bytes():
                bytes_received += len(chunk)
    except (httpx.ReadTimeout, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
        return TurnResult(
            intent_label=intent_label,
            elapsed_ms=(time.perf_counter() - started) * 1000,
            bytes_received=bytes_received,
            error=str(exc),
        )
    return TurnResult(
        intent_label=intent_label,
        elapsed_ms=(time.perf_counter() - started) * 1000,
        bytes_received=bytes_received,
    )


async def run_pass(
    base_url: str,
    token: str,
    queries: Iterable[tuple[str, str, str]],
    label: str,
    concurrency: int = 1,
) -> list[TurnResult]:
    """Drive one pass through `queries`. Concurrency 1 keeps the timing
    clean by serialising — for the latency-per-turn metric we don't want
    queue contention on the server skewing the numbers."""
    print(f"\n=== pass: {label} (concurrency={concurrency}) ===", flush=True)
    out: list[TurnResult] = []
    async with httpx.AsyncClient(http2=False) as client:
        if concurrency == 1:
            for intent_label, lang, msg in queries:
                r = await one_turn(client, base_url, token, intent_label, lang, msg)
                out.append(r)
                marker = "OK" if r.error is None else "ERR"
                print(
                    f"  [{marker}] {r.intent_label:14s} "
                    f"{r.elapsed_ms:7.1f} ms  "
                    f"{r.bytes_received:6d}B"
                    + (f"  {r.error}" if r.error else ""),
                    flush=True,
                )
        else:
            sem = asyncio.Semaphore(concurrency)
            async def _gated(args):
                async with sem:
                    return await one_turn(client, base_url, token, *args)
            out = await asyncio.gather(*(_gated(q) for q in queries))
    return out


def summarise(results: list[TurnResult], label: str) -> None:
    by_intent: dict[str, list[float]] = {}
    for r in results:
        if r.error:
            continue
        by_intent.setdefault(r.intent_label, []).append(r.elapsed_ms)
    print(f"\n--- summary: {label} ---")
    print(f"{'intent':<16} {'n':>3} {'p50':>8} {'p95':>8} {'mean':>8} {'max':>8}")
    for intent in sorted(by_intent):
        xs = sorted(by_intent[intent])
        if not xs:
            continue
        p50 = xs[len(xs) // 2]
        p95 = xs[int(len(xs) * 0.95) - 1] if len(xs) > 1 else xs[0]
        mean = statistics.mean(xs)
        print(f"{intent:<16} {len(xs):>3d} {p50:>7.1f} {p95:>7.1f} {mean:>7.1f} {max(xs):>7.1f}")
    # Overall.
    all_xs = sorted([r.elapsed_ms for r in results if r.error is None])
    if all_xs:
        print(f"{'overall':<16} {len(all_xs):>3d} "
              f"{all_xs[len(all_xs)//2]:>7.1f} "
              f"{all_xs[int(len(all_xs)*0.95)-1] if len(all_xs)>1 else all_xs[0]:>7.1f} "
              f"{statistics.mean(all_xs):>7.1f} "
              f"{max(all_xs):>7.1f}")
    errors = [r for r in results if r.error]
    if errors:
        print(f"  errors: {len(errors)}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--url", default=os.environ.get("SERVER_URL", "http://localhost:8080"),
        help="Base URL of the chat service (no trailing slash).",
    )
    parser.add_argument(
        "--token", default=os.environ.get("APP_TOKEN", ""),
        help="X-App-Token value.",
    )
    parser.add_argument(
        "--passes", type=int, default=2,
        help="How many times to replay the query set (default 2: cold + warm).",
    )
    parser.add_argument(
        "--concurrency", type=int, default=1,
        help="Parallel requests per pass (default 1 — serial for clean latency).",
    )
    args = parser.parse_args()

    all_results: list[tuple[str, list[TurnResult]]] = []
    for i in range(args.passes):
        label = "cold" if i == 0 else f"warm-{i}"
        results = await run_pass(args.url, args.token, _QUERIES, label, args.concurrency)
        all_results.append((label, results))
        summarise(results, label)

    print("\n=== cross-pass comparison ===")
    print(f"{'intent':<16}", end="")
    for label, _ in all_results:
        print(f" {label + ' p50':>12}", end="")
    print()
    intents = sorted({r.intent_label for _, rs in all_results for r in rs if r.error is None})
    for intent in intents:
        print(f"{intent:<16}", end="")
        for _, rs in all_results:
            xs = sorted([r.elapsed_ms for r in rs if r.intent_label == intent and r.error is None])
            if not xs:
                print(f" {'-':>12}", end="")
                continue
            p50 = xs[len(xs) // 2]
            print(f" {p50:>11.1f}", end="")
        print()


if __name__ == "__main__":
    asyncio.run(main())

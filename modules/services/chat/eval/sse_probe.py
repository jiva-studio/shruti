#!/usr/bin/env python3
"""Shared probe for the chat `/chat` SSE endpoint — mint, fire, parse.

Single source of truth for two consumers that used to carry their own copy:

  - `eval/run_eval.py`                  batch eval harness
  - `.claude/skills/chat-sse-probe`     interactive one-turn probe

Keep both on this module. A duplicated parser rots silently when an event or
a log message is renamed — `pipeline_short_path` -> `pipeline_lean_path` is
exactly that kind of change.

CLI (what the skill drives):

    python eval/sse_probe.py fire  --url https://…/chat --query "…" --lang ru --out /tmp/sse.txt
    python eval/sse_probe.py parse --in /tmp/sse.txt
    python eval/sse_probe.py mint                       # token only, for curl

`fire` prints `trace_id=<hex>` — that id IS the Langfuse trace id (see the
langfuse-fetch skill). The token is never printed unless `mint` is asked for.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import uuid
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Project root sits two levels above the repo: <…>/lectorium/source/lectorium.
DEFAULT_JWT_KEY = HERE.parents[5] / ".config/lectorium/jwt/private.pem"

EVENT_RE = re.compile(r"^event:\s*(\w+)\s*\ndata:\s*(.*)$", re.M)
MARKER_RE = re.compile(r"\[(?:verse|chapter|cite|card|outline):[^\]]+\]")


def mint_token(key_path: str | Path | None = None, *, sub: str = "probe",
               tier: str = "pro", ttl: int = 600) -> str:
    """RS256 `kid=v1` token the chat verifier accepts (`aud=chat`, `sub`, `exp`)."""
    import jwt  # PyJWT

    key = Path(key_path or DEFAULT_JWT_KEY).read_text()
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "aud": "chat", "anonymous": False, "tier": tier,
         "iat": now, "exp": now + ttl},
        key, algorithm="RS256", headers={"kid": "v1"},
    )


def new_trace_id() -> str:
    """32 lowercase hex — sent as X-Trace-Id, becomes the Langfuse trace id."""
    return uuid.uuid4().hex


def fire(url: str, token: str, trace_id: str, query: str, lang: str,
         timeout: int = 120) -> tuple[str, float]:
    """POST one SSE turn; return (raw_stream, wall_seconds)."""
    body = json.dumps({"messages": [{"role": "user", "content": query}], "lang": lang})
    t0 = time.time()
    proc = subprocess.run(
        ["curl", "-sN", "--max-time", str(timeout), "-X", "POST", url,
         "-H", f"Authorization: Bearer {token}",
         "-H", "X-Chat-Protocol-Version: 1",
         "-H", f"X-Trace-Id: {trace_id}",
         "-H", "Content-Type: application/json",
         "-d", body],
        capture_output=True, text=True,
    )
    return proc.stdout, time.time() - t0


def iter_events(raw: str) -> list[tuple[str, str]]:
    """Split the stream into (event, data) pairs, in order."""
    return EVENT_RE.findall(raw)


def _field(data: str, key: str) -> str | None:
    try:
        return json.loads(data).get(key)
    except Exception:
        return None


def delta_text(events: list[tuple[str, str]]) -> str:
    """Concatenated answer text. Each delta's data is JSON — json.loads it so
    Cyrillic decodes correctly (unicode_escape mangles UTF-8 into mojibake)."""
    return "".join(_field(d, "text") or "" for k, d in events if k == "delta")


def summarize(raw: str) -> dict:
    """Structural view of one turn — no secrets, just shape."""
    ev = iter_events(raw)
    answer = delta_text(ev)
    return {
        "events": dict(Counter(k for k, _ in ev)),
        "status": [_field(d, "key") for k, d in ev if k == "status"],
        "actions": [_field(d, "kind") for k, d in ev if k == "action"],
        "research_q": [_field(d, "question") or d[:80] for k, d in ev
                       if k == "research_question"],
        "n_sources": sum(1 for k, _ in ev if k == "research_source"),
        "markers": MARKER_RE.findall(answer),
        "answer": answer,
        "usage": [d[:200] for k, d in ev if k == "usage"],
        "done": [d[:200] for k, d in ev if k == "done"],
        "error": [d[:200] for k, d in ev if k == "error"],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("mint", help="print a probe JWT (do not log it)")
    m.add_argument("--key", default=str(DEFAULT_JWT_KEY))
    m.add_argument("--sub", default="probe")
    m.add_argument("--tier", default="pro")
    m.add_argument("--ttl", type=int, default=600)

    f = sub.add_parser("fire", help="send one turn, save the raw stream")
    f.add_argument("--url", required=True, help="full /chat endpoint URL")
    f.add_argument("--query", required=True)
    f.add_argument("--lang", default="ru")
    f.add_argument("--out", default="-", help="raw stream destination ('-' = stdout)")
    f.add_argument("--trace", default=None, help="reuse an X-Trace-Id instead of a new one")
    f.add_argument("--key", default=str(DEFAULT_JWT_KEY))
    f.add_argument("--timeout", type=int, default=120)
    f.add_argument("--parse", action="store_true", help="also print the summary")

    p = sub.add_parser("parse", help="summarize a saved raw stream")
    p.add_argument("--in", dest="src", required=True, help="file, or '-' for stdin")
    p.add_argument("--answer-chars", type=int, default=400)

    args = ap.parse_args(argv)

    if args.cmd == "mint":
        print(mint_token(args.key, sub=args.sub, tier=args.tier, ttl=args.ttl))
        return 0

    if args.cmd == "fire":
        trace = args.trace or new_trace_id()
        raw, wall = fire(args.url, mint_token(args.key), trace, args.query,
                         args.lang, timeout=args.timeout)
        if args.out == "-":
            sys.stdout.write(raw)
        else:
            Path(args.out).write_text(raw, encoding="utf-8")
        print(f"trace_id={trace}", file=sys.stderr)
        print(f"latency_s={wall:.1f}", file=sys.stderr)
        if args.parse:
            _print_summary(summarize(raw))
        return 0

    raw = sys.stdin.read() if args.src == "-" else Path(args.src).read_text(encoding="utf-8")
    _print_summary(summarize(raw), answer_chars=args.answer_chars)
    return 0


def _print_summary(s: dict, answer_chars: int = 400) -> None:
    for key in ("events", "status", "actions", "research_q", "n_sources",
                "markers", "usage", "done", "error"):
        print(f"{key}:", s[key])
    print("answer:", s["answer"][:answer_chars])


if __name__ == "__main__":
    raise SystemExit(main())

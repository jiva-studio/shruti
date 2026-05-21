#!/usr/bin/env python3
"""attribution-importer — bulk-import library.attribution.* via MCP HTTP.

See README.md for the full design. Quick summary:

  Input:  verse-centric YAML plan ({tokens, verse_id, topics, questions})
  Output: ~80-150 attribution rows + ~500-1000 refs in library.db
  Drives: lectorium-mcp daemon at http://127.0.0.1:8081/mcp (JSON-RPC)
  State:  state/<yaml-basename>.checkpoint.json (single source of truth
          for resume — see CHECKPOINT section below)

Architecture:

  1. PARSE       — load YAML, validate every entry has tokens + verse_id
  2. AGGREGATE   — build text → {verse_ids} maps for kind=topic and
                   kind=question. Exact text dedup (case-sensitive).
  3. CHECKPOINT  — load state file; skip any (kind, text) already in
                   `attributions` map; skip any (attr_id, target_id)
                   already in `refs_added` set.
  4. CREATE      — for each unique unseen (kind, text):
                     POST tools/call library.attribution.create
                     → record `attribution_id` in checkpoint, fsync
  5. REF_ADD     — for each (attribution, verse_id) not yet linked:
                     POST tools/call library.attribution.ref_add
                     → record in checkpoint, fsync
  6. (optional)  --publish: POST library.publish to push library.db to S3

Why HTTP not in-process: keeps the importer untied to MCP daemon's
internals. The daemon stays running with one connection; the script
can be re-run from any machine that can reach it. Single-process, no
concurrency — order is: every create, then every ref_add. This avoids
race conditions where ref_add fires before its parent create returns.

CHECKPOINT INVARIANTS:

  - The checkpoint file is updated AFTER each successful MCP call.
    `fsync` after every write so a `kill -9` mid-import doesn't lose
    state. Atomicity: write to `.tmp`, then `os.replace` (POSIX atomic).
  - Re-running the script with the same checkpoint is a no-op for
    already-completed work — only the remainder gets retried.
  - `--reset-state` is the ONLY way to wipe the checkpoint. Prompts
    `yes/no` because forgetting and re-running would double-create all
    attributions (MCP create does NOT dedupe by text).

ERROR HANDLING:

  - Network blip / 5xx on a single call: log error, increment counter,
    move on to the next item. The failed item is NOT marked done — it
    will be retried on the next run.
  - validation_failed envelope (e.g. ref_add to a verse_id that doesn't
    exist in library.db): same — log, count, continue. Curator must
    fix the YAML and re-run.
  - Truly broken state (can't reach MCP at all): abort with non-zero
    exit so CI catches it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import uuid
from collections import defaultdict
from pathlib import Path

import httpx
import yaml


# ---- MCP client ------------------------------------------------------------


class MCPError(RuntimeError):
    """Wraps an MCP envelope error or transport failure."""

    def __init__(self, code: str, message: str, raw: dict | None = None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.raw = raw or {}


class MCPClient:
    """Minimal JSON-RPC client for the streamable HTTP transport.

    lectorium-mcp serves MCP at /mcp accepting POSTs with JSON-RPC bodies.
    For our use-case (tools/call only) we don't need an init handshake —
    the daemon tolerates calls without one. We do send a unique request
    id per call and parse `result.content[0].text` as the tool envelope.
    """

    def __init__(self, base_url: str, timeout: float = 30.0):
        self.url = base_url
        self.client = httpx.Client(
            timeout=timeout,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
        )

    def close(self) -> None:
        self.client.close()

    def call_tool(self, name: str, arguments: dict) -> dict:
        """Invoke a tool. Returns the tool's envelope (parsed `result`).
        Raises MCPError on transport failure or `{ok: false}` envelope."""
        body = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        try:
            resp = self.client.post(self.url, json=body)
        except httpx.RequestError as exc:
            raise MCPError("transport", f"http request failed: {exc}") from exc
        if resp.status_code >= 400:
            raise MCPError(
                "transport",
                f"http {resp.status_code}: {resp.text[:200]}",
            )
        # Streamable HTTP may return either JSON or SSE. We always send
        # Accept: application/json,text/event-stream — the daemon picks
        # JSON when the response fits in one shot (which tools/call does).
        ct = resp.headers.get("content-type", "")
        if "text/event-stream" in ct:
            envelope = _parse_sse_response(resp.text, body["id"])
        else:
            envelope = resp.json()

        if "error" in envelope:
            err = envelope["error"]
            raise MCPError(
                err.get("code", "rpc"),
                err.get("message", "(no message)"),
                raw=envelope,
            )
        result = envelope.get("result", {})
        content = result.get("content") or []
        if not content:
            raise MCPError("empty_response", f"no content from {name}", raw=envelope)
        # Tool envelopes come back as a text block whose body is JSON.
        text = content[0].get("text", "")
        try:
            tool_env = json.loads(text)
        except json.JSONDecodeError as exc:
            raise MCPError(
                "decode", f"could not parse tool envelope: {exc}; raw={text[:200]}"
            ) from exc

        if not tool_env.get("ok", False):
            err = tool_env.get("error", {})
            raise MCPError(
                err.get("code", "unknown"),
                err.get("message", "(no message)"),
                raw=tool_env,
            )
        return tool_env.get("result", {})


def _parse_sse_response(body: str, want_id: str) -> dict:
    """Pluck a single JSON-RPC reply out of an SSE response body. Used
    only when the daemon decides to stream the answer."""
    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if str(parsed.get("id", "")) == want_id:
            return parsed
    raise MCPError("sse", "no matching JSON-RPC reply in SSE stream")


# ---- checkpoint ------------------------------------------------------------


class Checkpoint:
    """JSON-on-disk checkpoint. Atomic writes via tempfile + os.replace."""

    def __init__(self, path: Path, yaml_path: Path) -> None:
        self.path = path
        if path.exists():
            self.state = json.loads(path.read_text(encoding="utf-8"))
        else:
            self.state = {
                "yaml_path": str(yaml_path.resolve()),
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "attributions": {},   # "kind:text" → attribution_id
                "refs_added": [],     # ["attribution_id:ref_kind:target_id", ...]
            }
            self._flush()

    def _flush(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
        # fsync the file before rename so a hard crash doesn't lose recent
        # checkpoint state (the rename is atomic on POSIX).
        with tmp.open("rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def attribution_key(self, kind: str, text: str) -> str:
        return f"{kind}:{text}"

    def ref_key(self, attr_id: str, ref_kind: str, target_id: str) -> str:
        return f"{attr_id}:{ref_kind}:{target_id}"

    def has_attribution(self, kind: str, text: str) -> str | None:
        return self.state["attributions"].get(self.attribution_key(kind, text))

    def has_ref(self, attr_id: str, ref_kind: str, target_id: str) -> bool:
        return self.ref_key(attr_id, ref_kind, target_id) in set(self.state["refs_added"])

    def record_attribution(self, kind: str, text: str, attr_id: str) -> None:
        self.state["attributions"][self.attribution_key(kind, text)] = attr_id
        self._flush()

    def record_ref(self, attr_id: str, ref_kind: str, target_id: str) -> None:
        key = self.ref_key(attr_id, ref_kind, target_id)
        if key not in self.state["refs_added"]:
            self.state["refs_added"].append(key)
            self._flush()


# ---- core ------------------------------------------------------------------


def parse_yaml(path: Path) -> tuple[str, str, list[dict]]:
    """Returns (source_id, language, verses)."""
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    source_id = doc.get("source_id")
    if not source_id:
        raise ValueError(f"{path}: missing source_id")
    language = doc.get("language")
    if not language:
        raise ValueError(f"{path}: missing language")
    verses = doc.get("verses") or []
    for i, v in enumerate(verses):
        if "tokens" not in v or "verse_id" not in v:
            raise ValueError(f"{path}: verses[{i}] missing tokens or verse_id")
    return source_id, language, verses


def aggregate(verses: list[dict]) -> tuple[dict[str, list[tuple[str, str]]], dict[str, list[tuple[str, str]]]]:
    """Returns (topics, questions) where each is text → [(ref_kind, target_id), ...].

    For now ref_kind is always 'verse' since the v1 YAML doesn't carry
    document refs. Document support is in the schema for forward-compat."""
    topics: dict[str, set[tuple[str, str]]] = defaultdict(set)
    questions: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for v in verses:
        verse_ref = ("verse", v["verse_id"])
        for t in v.get("topics") or []:
            topics[t.strip()].add(verse_ref)
        for q in v.get("questions") or []:
            questions[q.strip()].add(verse_ref)
        # Future: document refs.
        for doc_id in v.get("documents") or []:
            doc_ref = ("document", doc_id.strip())
            for t in v.get("topics") or []:
                topics[t.strip()].add(doc_ref)
            for q in v.get("questions") or []:
                questions[q.strip()].add(doc_ref)
    return (
        {k: sorted(v) for k, v in topics.items()},
        {k: sorted(v) for k, v in questions.items()},
    )


def run_import(
    yaml_path: Path,
    *,
    mcp_url: str,
    state_dir: Path,
    dry_run: bool,
    publish: bool,
) -> int:
    source_id, language, verses = parse_yaml(yaml_path)
    topics, questions = aggregate(verses)

    print(f"[parse] {yaml_path.name}: source={source_id} lang={language} verses={len(verses)}")
    print(f"        topics: {len(topics)} unique  /  questions: {len(questions)} unique")

    if dry_run:
        print("[dry-run] would create:")
        for text, refs in topics.items():
            print(f"  topic     {text!r:60s} → {len(refs)} ref(s)")
        for text, refs in questions.items():
            print(f"  question  {text!r:60s} → {len(refs)} ref(s)")
        return 0

    ckpt_path = state_dir / f"{yaml_path.stem}.checkpoint.json"
    ckpt = Checkpoint(ckpt_path, yaml_path)
    print(f"[ckpt] {ckpt_path}: {len(ckpt.state['attributions'])} attrs, "
          f"{len(ckpt.state['refs_added'])} refs already recorded")

    client = MCPClient(mcp_url)
    started = time.monotonic()
    stats = {
        "topic_created": 0,
        "topic_existed": 0,
        "question_created": 0,
        "question_existed": 0,
        "refs_added": 0,
        "refs_existed": 0,
        "errors": 0,
    }

    def _create(kind: str, text: str) -> str | None:
        existing = ckpt.has_attribution(kind, text)
        if existing:
            stats[f"{kind}_existed"] += 1
            return existing
        try:
            res = client.call_tool(
                "library.attribution.create",
                {"kind": kind, "language": language, "text": text},
            )
        except MCPError as exc:
            stats["errors"] += 1
            print(f"  ERR create {kind} {text!r}: {exc}", file=sys.stderr)
            return None
        attr_id = res.get("id")
        if not attr_id:
            stats["errors"] += 1
            print(f"  ERR create {kind} {text!r}: no id in result", file=sys.stderr)
            return None
        ckpt.record_attribution(kind, text, attr_id)
        stats[f"{kind}_created"] += 1
        print(f"  + {kind:8s} {attr_id} ← {text!r}")
        return attr_id

    def _ref_add(attr_id: str, ref_kind: str, target_id: str) -> None:
        if ckpt.has_ref(attr_id, ref_kind, target_id):
            stats["refs_existed"] += 1
            return
        try:
            client.call_tool(
                "library.attribution.ref_add",
                {"id": attr_id, "ref_kind": ref_kind, "target_id": target_id},
            )
        except MCPError as exc:
            stats["errors"] += 1
            print(f"  ERR ref_add {attr_id}/{ref_kind}/{target_id}: {exc}", file=sys.stderr)
            return
        ckpt.record_ref(attr_id, ref_kind, target_id)
        stats["refs_added"] += 1

    try:
        # Phase A: create attributions. Topics first, then questions —
        # topics are smaller in count and lower-stakes (fail-tolerant for
        # boost matching) so they're a good warm-up for the LLM translator.
        print(f"[create] topics ({len(topics)}):")
        topic_ids: dict[str, str] = {}
        for text in topics:
            aid = _create("topic", text)
            if aid:
                topic_ids[text] = aid

        print(f"[create] questions ({len(questions)}):")
        question_ids: dict[str, str] = {}
        for text in questions:
            aid = _create("question", text)
            if aid:
                question_ids[text] = aid

        # Phase B: ref_add. One pass per attribution, all its refs.
        print(f"[ref_add] topics:")
        for text, refs in topics.items():
            aid = topic_ids.get(text)
            if not aid:
                continue
            for ref_kind, target_id in refs:
                _ref_add(aid, ref_kind, target_id)

        print(f"[ref_add] questions:")
        for text, refs in questions.items():
            aid = question_ids.get(text)
            if not aid:
                continue
            for ref_kind, target_id in refs:
                _ref_add(aid, ref_kind, target_id)

        # Phase C (optional): publish library.db to S3 so chat-service can
        # pull it on the next indexer tick.
        if publish:
            print("[publish] library.publish ...")
            try:
                res = client.call_tool("library.publish", {})
                print(f"  publish run dispatched: {json.dumps(res, ensure_ascii=False)}")
            except MCPError as exc:
                stats["errors"] += 1
                print(f"  ERR publish: {exc}", file=sys.stderr)
    finally:
        client.close()

    elapsed = time.monotonic() - started
    print("[summary]")
    print(f"  yaml        {yaml_path.name}")
    print(f"  verses      {len(verses)}")
    print(f"  topics      {len(topics)} unique"
          f" ({stats['topic_created']} created, {stats['topic_existed']} already present)")
    print(f"  questions   {len(questions)} unique"
          f" ({stats['question_created']} created, {stats['question_existed']} already present)")
    print(f"  refs added  {stats['refs_added']} ({stats['refs_existed']} already present)")
    print(f"  errors      {stats['errors']}")
    print(f"  elapsed     {elapsed:.1f}s")

    return 0 if stats["errors"] == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("yaml_path", type=Path)
    parser.add_argument("--mcp-url", default="http://127.0.0.1:8081/mcp",
                        help="lectorium-mcp endpoint (default: http://127.0.0.1:8081/mcp)")
    parser.add_argument("--state-dir", type=Path,
                        default=Path(__file__).parent / "state",
                        help="directory for checkpoint files")
    parser.add_argument("--dry-run", action="store_true",
                        help="show what would happen, make no MCP calls")
    parser.add_argument("--publish", action="store_true",
                        help="dispatch library.publish at the end")
    parser.add_argument("--reset-state", action="store_true",
                        help="wipe the checkpoint before running (CONFIRMS FIRST)")
    args = parser.parse_args()

    if not args.yaml_path.exists():
        print(f"YAML not found: {args.yaml_path}", file=sys.stderr)
        return 2

    if args.reset_state:
        ckpt_path = args.state_dir / f"{args.yaml_path.stem}.checkpoint.json"
        if ckpt_path.exists():
            print(f"!! About to delete {ckpt_path}. This will cause a re-import that")
            print("   DUPLICATES every attribution (library.attribution.create does NOT")
            print("   dedupe by text). Type 'yes' to confirm:")
            if input("> ").strip().lower() != "yes":
                print("aborted", file=sys.stderr)
                return 1
            ckpt_path.unlink()
            print(f"  deleted {ckpt_path}")

    return run_import(
        args.yaml_path.resolve(),
        mcp_url=args.mcp_url,
        state_dir=args.state_dir,
        dry_run=args.dry_run,
        publish=args.publish,
    )


if __name__ == "__main__":
    sys.exit(main())

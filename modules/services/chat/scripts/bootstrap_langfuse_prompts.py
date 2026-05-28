"""bootstrap_langfuse_prompts — sync the chat-service prompts ↔ Langfuse.

Reads every `.md` file under `app/src/shruti_chat/agent/prompts/`
(`header`, `tools`, `actions`, `followups`, `no_narration`,
`citations`, `note_types`, `quoting`, `response_shape`, `language`,
`safety`, `grounding`, `router`, `query_planner`, `synthesis_planner`,
`topic_extractor`, `caption_generator`) and keeps them aligned with our
Langfuse instance.

Subcommands:

    list                  — for every known prompt, show "in repo / in
                            Langfuse / match" so you can see at a glance
                            what drifted.
    push  [NAMES…]        — `.md` → Langfuse, idempotent. Skips any
                            entry whose content + config + tags
                            already match the production version
                            (does NOT create a new version-clone).
    pull  [NAMES…]        — Langfuse → `.md`. Overwrites the local
                            file with the production text; use to
                            pick up an edit made in the Langfuse UI.
    diff  [NAMES…]        — unified diff of the local `.md` vs the
                            Langfuse production text. Read-only.

`NAMES` is an optional positional filter (one or more Langfuse prompt
names like `chat-section-header`); empty = all known prompts.

`push --dry-run` shows what would be pushed without contacting
Langfuse, useful for verifying the file resolution + config payloads.

`structured_output` prompts (router / query-planner / synthesis-planner /
topic-extractor / caption-generator) have `temperature` documented in
config but the LLM adapter forces 0 internally — see
`infra/llm_provider/openrouter.py::structured_output`. The `config`
field is still set for visibility in the Langfuse UI; editing it
won't change behaviour for these four prompts.

Usage::

    LANGFUSE_HOST=https://langfuse.obs.eu.shruti.akdasa.studio \\
    LANGFUSE_PUBLIC_KEY=pk-... \\
    LANGFUSE_SECRET_KEY=sk-... \\
    python scripts/bootstrap_langfuse_prompts.py push

Old prompt names (e.g. `chat-section-library` after the rename to
`chat-section-note_types`) are left in Langfuse untouched. `pull` /
`diff` / `push` only operate on names listed in `_PROMPTS` below, so
historical names sit harmlessly in the UI until you snap their
`production` label by hand.
"""

from __future__ import annotations

import argparse
import difflib
import os
import sys
from pathlib import Path
from typing import Any, Iterable


# Defaults match `Settings.llm_*` in `config.py`. When the config in
# Langfuse is empty (fallback path) the chat code falls back to these
# same values via `Settings`, so behaviour is identical.
_DEFAULT_LLM = "openrouter/deepseek/deepseek-chat"
_OUTLINE_LLM = "openrouter/google/gemini-2.0-flash-001"
_FLASH_LITE = "openrouter/google/gemini-3.1-flash-lite"
_FLASH = "openrouter/google/gemini-2.5-flash"


# Each entry: (langfuse_prompt_name, source_ref, config, tags).
# `source_ref` is the filename under `agent/prompts/` (without `.md`).
# `tags` filter the prompt in the Langfuse UI — `synth`/`worker`/
# `router`/`research` mirror the agent-graph role the section feeds.
_PROMPTS: list[tuple[str, str, dict, list[str]]] = [
    # ── research pipeline (3 short structured_output calls) ────────────
    (
        "query-planner", "query_planner",
        {"model": _FLASH_LITE, "temperature": 0, "note": "structured_output → temperature forced to 0"},
        ["chat", "research"],
    ),
    (
        "synthesis-planner", "synthesis_planner",
        {"model": _FLASH, "temperature": 0, "schema": "Outline",
         "note": "structured_output → temperature forced to 0; uses full Flash (not Lite) — attribution selection over 15-25 notes"},
        ["chat", "synth"],
    ),
    (
        "conclusion-writer", "conclusion_writer",
        {"model": _FLASH_LITE, "temperature": 0, "schema": "ConclusionResponse",
         "note": "structured_output → temperature forced to 0; fallback for outlines with 3+ theses where synthesis-planner left conclusion null"},
        ["chat", "synth"],
    ),
    (
        "topic-extractor", "topic_extractor",
        {"model": _FLASH_LITE, "temperature": 0, "note": "structured_output → temperature forced to 0"},
        ["chat", "research"],
    ),
    (
        "caption-generator", "caption_generator",
        {"model": _FLASH_LITE, "temperature": 0, "note": "structured_output → temperature forced to 0"},
        ["chat", "research"],
    ),
    # ── router ────────────────────────────────────────────────────────
    (
        "chat-router", "router",
        {"model": _FLASH_LITE, "temperature": 0, "schema": "RoutingDecision",
         "note": "structured_output → temperature forced to 0"},
        ["chat", "router"],
    ),
    # ── chat-section-* (modular synth/worker prompt) ───────────────────
    ("chat-section-header", "header", {}, ["chat", "synth", "worker"]),
    ("chat-section-tools", "tools", {}, ["chat", "worker"]),
    ("chat-section-actions", "actions", {}, ["chat", "synth", "worker"]),
    ("chat-section-followups", "followups", {}, ["chat", "synth"]),
    ("chat-section-no_narration", "no_narration", {}, ["chat", "synth"]),
    ("chat-section-citations", "citations", {}, ["chat", "synth"]),
    ("chat-section-note_types", "note_types", {}, ["chat", "synth"]),
    ("chat-section-quoting", "quoting", {}, ["chat", "synth", "worker"]),
    ("chat-section-response_shape", "response_shape", {}, ["chat", "synth"]),
    ("chat-section-language", "language", {}, ["chat", "synth"]),
    ("chat-section-safety", "safety", {}, ["chat", "synth"]),
    ("chat-section-grounding", "grounding", {}, ["chat", "synth"]),
]


def _repo_root() -> Path:
    """Script is at `modules/services/chat/scripts/...`; the chat app
    lives at `modules/services/chat/app/`. Resolve relative to this
    file so the script works regardless of cwd."""
    return Path(__file__).resolve().parent.parent / "app"


def _prompt_path(ref: str) -> Path:
    return (
        _repo_root() / "src" / "shruti_chat" / "agent" / "prompts" / f"{ref}.md"
    )


def _load_md(ref: str) -> str:
    path = _prompt_path(ref)
    if not path.exists():
        raise FileNotFoundError(f"prompt md missing: {path}")
    return path.read_text(encoding="utf-8")


def _filtered(names: Iterable[str]) -> list[tuple[str, str, dict, list[str]]]:
    """Filter the `_PROMPTS` table by user-supplied name list (empty
    list = all). Returns rows in `_PROMPTS` order so output is stable.
    Unknown names print a warning and are dropped."""
    name_set = set(names)
    if not name_set:
        return list(_PROMPTS)
    known = {row[0] for row in _PROMPTS}
    for n in name_set - known:
        print(f"warning: unknown prompt name (skipping): {n}", file=sys.stderr)
    return [row for row in _PROMPTS if row[0] in name_set]


def _fetch_existing(client: Any, name: str, label: str) -> dict | None:
    """Return the current Langfuse state of a prompt, or None if
    missing. `cache_ttl_seconds=0` forces a live fetch so we don't
    diff against a stale local cache."""
    try:
        p = client.get_prompt(name, label=label, cache_ttl_seconds=0)
    except Exception:  # noqa: BLE001
        return None
    return {
        "prompt": p.prompt,
        "config": p.config or {},
        "tags": list(getattr(p, "tags", None) or []),
    }


def _client_or_exit(needed: bool):
    host = os.environ.get("LANGFUSE_HOST")
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if needed and not (host and public_key and secret_key):
        print(
            "error: set LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / "
            "LANGFUSE_SECRET_KEY",
            file=sys.stderr,
        )
        sys.exit(2)
    if not needed:
        return None
    from langfuse import Langfuse  # type: ignore
    return Langfuse(host=host, public_key=public_key, secret_key=secret_key)


# ── subcommands ────────────────────────────────────────────────────────


def cmd_push(args: argparse.Namespace) -> int:
    # Dry-run still needs creds — we need to fetch the current
    # Langfuse state to honestly report "unchanged / would update /
    # would create". Without creds the dry-run would mark every
    # prompt as "would create", which is misleading.
    client = _client_or_exit(needed=True)
    rows = _filtered(args.names)
    counts = {"unchanged": 0, "updated": 0, "created": 0, "failed": 0}
    failures: list[tuple[str, str]] = []
    print(f"# push: {len(rows)} prompts → label={args.label}")
    for name, ref, config, tags in rows:
        try:
            text = _load_md(ref)
        except Exception as exc:  # noqa: BLE001
            failures.append((name, f"load failed: {exc}"))
            counts["failed"] += 1
            continue

        existing = _fetch_existing(client, name, args.label)
        # Strict equality on every field we control: matching means
        # nothing for the user would change, so a new version is pure
        # noise — skip.
        if existing is not None and (
            existing["prompt"] == text
            and existing["config"] == config
            and set(existing["tags"]) == set(tags)
        ):
            print(f"  [unchanged] {name}")
            counts["unchanged"] += 1
            continue

        verb = "would create" if existing is None else "would update"
        if args.dry_run:
            print(f"  [dry-run] {verb} {name} ({len(text):>5d} chars, tags={tags})")
            counts["created" if existing is None else "updated"] += 1
            continue

        try:
            client.create_prompt(
                name=name,
                prompt=text,
                labels=[args.label],
                config=config,
                tags=tags,
            )
        except Exception as exc:  # noqa: BLE001
            failures.append((name, f"push failed: {exc}"))
            counts["failed"] += 1
            continue
        if existing is None:
            print(f"  [created]  {name}  v1, tags={tags}")
            counts["created"] += 1
        else:
            print(f"  [updated]  {name}  +v, tags={tags}")
            counts["updated"] += 1

    client.shutdown()

    print(
        f"# summary: unchanged={counts['unchanged']} "
        f"updated={counts['updated']} created={counts['created']} "
        f"failed={counts['failed']}"
    )
    if failures:
        print("# failures:", file=sys.stderr)
        for name, msg in failures:
            print(f"  - {name}: {msg}", file=sys.stderr)
        return 1
    return 0


def cmd_pull(args: argparse.Namespace) -> int:
    client = _client_or_exit(needed=True)
    rows = _filtered(args.names)
    counts = {"written": 0, "missing": 0, "unchanged": 0}
    print(f"# pull: {len(rows)} prompts ← label={args.label}")
    for name, ref, _config, _tags in rows:
        existing = _fetch_existing(client, name, args.label)
        if existing is None:
            print(f"  [missing]   {name}  (not in Langfuse — left local file untouched)")
            counts["missing"] += 1
            continue
        path = _prompt_path(ref)
        local = path.read_text(encoding="utf-8") if path.exists() else None
        if local == existing["prompt"]:
            print(f"  [unchanged] {name}")
            counts["unchanged"] += 1
            continue
        path.write_text(existing["prompt"], encoding="utf-8")
        print(f"  [written]   {name} → {path.relative_to(_repo_root().parent)}")
        counts["written"] += 1
    client.shutdown()
    print(
        f"# summary: written={counts['written']} "
        f"unchanged={counts['unchanged']} missing={counts['missing']}"
    )
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    client = _client_or_exit(needed=True)
    rows = _filtered(args.names)
    any_diff = False
    for name, ref, _config, _tags in rows:
        local = _load_md(ref)
        existing = _fetch_existing(client, name, args.label)
        remote = existing["prompt"] if existing else ""
        if local == remote:
            continue
        any_diff = True
        diff = difflib.unified_diff(
            remote.splitlines(keepends=True),
            local.splitlines(keepends=True),
            fromfile=f"langfuse:{name}@{args.label}",
            tofile=f"local:{ref}.md",
            n=2,
        )
        sys.stdout.writelines(diff)
        sys.stdout.write("\n")
    client.shutdown()
    if not any_diff:
        print("# no differences")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    client = _client_or_exit(needed=True)
    print(f"# {'name':<32}  {'local':>6}  {'remote':>6}  state")
    for name, ref, _config, _tags in _PROMPTS:
        local = _load_md(ref) if _prompt_path(ref).exists() else None
        existing = _fetch_existing(client, name, args.label)
        local_n = len(local) if local is not None else 0
        remote_n = len(existing["prompt"]) if existing else 0
        if local is None and existing is None:
            state = "absent"
        elif local is None:
            state = "remote-only"
        elif existing is None:
            state = "local-only"
        elif local == existing["prompt"]:
            state = "match"
        else:
            state = "differ"
        print(f"  {name:<32}  {local_n:>6}  {remote_n:>6}  {state}")
    client.shutdown()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_push = sub.add_parser("push", help="`.md` → Langfuse (idempotent)")
    p_push.add_argument("--dry-run", action="store_true")
    p_push.add_argument("--label", default="production")
    p_push.add_argument("names", nargs="*")
    p_push.set_defaults(func=cmd_push)

    p_pull = sub.add_parser("pull", help="Langfuse → `.md`")
    p_pull.add_argument("--label", default="production")
    p_pull.add_argument("names", nargs="*")
    p_pull.set_defaults(func=cmd_pull)

    p_diff = sub.add_parser("diff", help="unified diff local vs Langfuse")
    p_diff.add_argument("--label", default="production")
    p_diff.add_argument("names", nargs="*")
    p_diff.set_defaults(func=cmd_diff)

    p_list = sub.add_parser("list", help="show local/remote state per prompt")
    p_list.add_argument("--label", default="production")
    p_list.set_defaults(func=cmd_list)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

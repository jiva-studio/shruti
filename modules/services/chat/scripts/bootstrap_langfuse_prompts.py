"""bootstrap_langfuse_prompts — push the 15 chat-service prompts into Langfuse.

Reads:
- All `.md` files under `app/src/lectorium_chat/agent/prompts/`
  (`header`, `tools`, `actions`, `followups`, `no_narration`,
  `citations`, `library`, `quoting`, `response_shape`, `language`,
  `safety`, `query_expander`, `topic_extractor`, `caption_generator`)
- The hardcoded `_ROUTER_SYSTEM_PROMPT` from
  `app/src/lectorium_chat/application/router_turn.py`

Writes 15 prompts via `langfuse.create_prompt(name, prompt, labels,
config)`. Each prompt is published with label `production` and a
`config` dict carrying the model + temperature recommendations that
match what the in-code defaults expect. Running this script twice
just creates `version=2`; we never overwrite, so a misconfigured
config is reversible from the Langfuse UI by re-promoting an older
version to `production`.

Usage::

    LANGFUSE_HOST=https://langfuse.obs.eu.lectorium.akdasa.studio \\
    LANGFUSE_PUBLIC_KEY=pk-... \\
    LANGFUSE_SECRET_KEY=sk-... \\
    python scripts/bootstrap_langfuse_prompts.py

`--dry-run` prints what would be pushed without contacting Langfuse —
useful for verifying the file resolution + config payloads before a
real push.

`structured_output` prompts (router / query-expander / topic-extractor
/ caption-generator) have `temperature` documented in config but the
LLM adapter forces 0 internally — see
`infra/llm_provider/openrouter.py::structured_output`. The `config`
field is still set for visibility in the Langfuse UI; editing it
won't change behaviour for these four prompts.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


# Defaults match `Settings.llm_*` in `config.py`. When the config in
# Langfuse is empty (fallback path) the chat code falls back to these
# same values via `Settings`, so behaviour is identical.
_DEFAULT_LLM = "openrouter/deepseek/deepseek-chat"
_OUTLINE_LLM = "openrouter/google/gemini-2.0-flash-001"
_FLASH_LITE = "openrouter/google/gemini-3.1-flash-lite"


# Each entry: (langfuse_prompt_name, source_kind, source_ref, config).
# `source_kind`:
#   "md"     — filename under `agent/prompts/` (without extension)
#   "router" — the in-code `_ROUTER_SYSTEM_PROMPT` constant from
#              `application/router_turn.py`
#
# `config["model"]` is honoured by the corresponding code path; the
# code reads `prompt.config.get("model")` and passes through to
# `LLMPort.structured_output` / `stream_completion`. The
# `_normalise_model` whitelist in `openrouter.py` will fall back to
# `llm_default` if a typo here makes it through review.
_PROMPTS: list[tuple[str, str, str, dict]] = [
    # ── research pipeline (3 short structured_output calls) ────────────
    (
        "query-expander", "md", "query_expander",
        {"model": _FLASH_LITE, "temperature": 0, "note": "structured_output → temperature forced to 0"},
    ),
    (
        "topic-extractor", "md", "topic_extractor",
        {"model": _FLASH_LITE, "temperature": 0, "note": "structured_output → temperature forced to 0"},
    ),
    (
        "caption-generator", "md", "caption_generator",
        {"model": _FLASH_LITE, "temperature": 0, "note": "structured_output → temperature forced to 0"},
    ),
    # ── router (in-code constant) ──────────────────────────────────────
    (
        "chat-router", "router", "_ROUTER_SYSTEM_PROMPT",
        {"model": _FLASH_LITE, "temperature": 0, "schema": "RoutingDecision",
         "note": "structured_output → temperature forced to 0"},
    ),
    # ── chat-section-* (modular synth/worker prompt) ───────────────────
    ("chat-section-header", "md", "header", {}),
    ("chat-section-tools", "md", "tools", {}),
    ("chat-section-actions", "md", "actions", {}),
    ("chat-section-followups", "md", "followups", {}),
    ("chat-section-no_narration", "md", "no_narration", {}),
    ("chat-section-citations", "md", "citations", {}),
    ("chat-section-library", "md", "library", {}),
    ("chat-section-quoting", "md", "quoting", {}),
    ("chat-section-response_shape", "md", "response_shape", {}),
    ("chat-section-language", "md", "language", {}),
    ("chat-section-safety", "md", "safety", {}),
]


def _repo_root() -> Path:
    """Script is at `modules/services/chat/scripts/...`; the chat app
    lives at `modules/services/chat/app/`. Resolve relative to this
    file so the script works regardless of cwd."""
    return Path(__file__).resolve().parent.parent / "app"


def _load_md(name: str) -> str:
    path = (
        _repo_root() / "src" / "lectorium_chat" / "agent" / "prompts" / f"{name}.md"
    )
    if not path.exists():
        raise FileNotFoundError(f"prompt md missing: {path}")
    return path.read_text(encoding="utf-8")


def _load_router_constant() -> str:
    """Import the hardcoded `_ROUTER_SYSTEM_PROMPT` constant. We import
    rather than parse so a stale snapshot of the prompt can't slip in —
    the running constant is the source of truth."""
    sys.path.insert(0, str(_repo_root() / "src"))
    from lectorium_chat.application.router_turn import _ROUTER_SYSTEM_PROMPT
    return _ROUTER_SYSTEM_PROMPT


def _load_prompt_text(kind: str, ref: str) -> str:
    if kind == "md":
        return _load_md(ref)
    if kind == "router":
        return _load_router_constant()
    raise ValueError(f"unknown prompt source kind: {kind!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be pushed without contacting Langfuse.",
    )
    parser.add_argument(
        "--label", default="production",
        help='Label to attach to each pushed prompt (default: "production").',
    )
    args = parser.parse_args()

    host = os.environ.get("LANGFUSE_HOST")
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if not args.dry_run and not (host and public_key and secret_key):
        print(
            "error: set LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / "
            "LANGFUSE_SECRET_KEY, or pass --dry-run",
            file=sys.stderr,
        )
        return 2

    client = None
    if not args.dry_run:
        from langfuse import Langfuse  # type: ignore
        client = Langfuse(host=host, public_key=public_key, secret_key=secret_key)

    print(f"# Loading {len(_PROMPTS)} prompts from repo …")
    failures: list[tuple[str, str]] = []
    for name, kind, ref, config in _PROMPTS:
        try:
            text = _load_prompt_text(kind, ref)
        except Exception as exc:  # noqa: BLE001
            failures.append((name, f"load failed: {exc}"))
            continue
        n_chars = len(text)
        if args.dry_run:
            print(f"  [dry-run] {name:32s} {kind:6s} {ref:24s} {n_chars:6d} chars  config={config}")
            continue
        try:
            client.create_prompt(
                name=name,
                prompt=text,
                labels=[args.label],
                config=config,
            )
            print(f"  [pushed]  {name:32s} {n_chars:6d} chars  config={config}")
        except Exception as exc:  # noqa: BLE001
            failures.append((name, f"push failed: {exc}"))

    if not args.dry_run and client is not None:
        client.shutdown()

    if failures:
        print("\n# Failures:")
        for name, msg in failures:
            print(f"  - {name}: {msg}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

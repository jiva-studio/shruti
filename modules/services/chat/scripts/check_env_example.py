#!/usr/bin/env python3
"""Every `Settings` field must appear in `.env.example`.

`.env.example` documents the service AND doubles as a working local-dev
template — several of its values deliberately differ from the model defaults
(`DATABASE_URL` points at the compose postgres, for one). So it is NOT
generated wholesale: that would replace a working template with a list of
defaults. Instead this checks the invariant that actually matters — no setting
is undiscoverable — and can emit a ready-to-paste block for whatever is
missing, carrying the field's own comment from `config.py` so the explanation
isn't rewritten from scratch.

    python scripts/check_env_example.py             # verify (exit 1 on gaps)
    python scripts/check_env_example.py --emit      # print the missing block

Run by `tests/test_env_example_complete.py`, so CI covers it.
"""

from __future__ import annotations

import argparse
import ast
import io
import re
import sys
import tokenize
from pathlib import Path


_HERE = Path(__file__).resolve().parent
_CONFIG = _HERE.parent / "app" / "src" / "shruti_chat" / "config.py"
_ENV_EXAMPLE = _HERE.parent / ".env.example"

# Documented elsewhere on purpose: they are read by compose / deploy.sh, not by
# `Settings`, and the file is shared with those.
_NON_SETTING_KEYS = {"DOMAIN", "ACME_EMAIL", "POSTGRES_PASSWORD"}

# Secrets have no useful default to emit.
_SECRET_HINT = re.compile(r"(api_key|password|secret|token|salt)$")


def _field_comments() -> dict[str, list[str]]:
    """Leading `#` block for each `Settings` field, straight from config.py.

    The explanations already live there — often with the incident that
    motivated the value — so a generated block should carry them rather than
    invent new prose.
    """
    source = _CONFIG.read_text()
    tree = ast.parse(source)
    settings = next(
        n for n in tree.body
        if isinstance(n, ast.ClassDef) and n.name == "Settings"
    )
    field_lines = {
        n.target.id: n.lineno
        for n in settings.body
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)
    }

    comments: dict[int, str] = {}
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.COMMENT:
            comments[tok.start[0]] = tok.string

    out: dict[str, list[str]] = {}
    for name, lineno in field_lines.items():
        block: list[str] = []
        probe = lineno - 1
        while probe in comments:
            text = comments[probe]
            # A section banner belongs to the section, not to one field.
            if "──" in text:
                break
            block.insert(0, text)
            probe -= 1
        out[name] = block
    return out


def _documented_keys() -> set[str]:
    """Keys mentioned in `.env.example`, commented-out defaults included —
    that is how the file records "this exists, here is its value"."""
    return set(
        re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", _ENV_EXAMPLE.read_text(), re.M)
    )


def _settings_fields() -> dict[str, object]:
    sys.path.insert(0, str(_HERE.parent / "app" / "src"))
    from shruti_chat.config import Settings

    return dict(Settings.model_fields)


def missing_settings() -> list[str]:
    documented = _documented_keys()
    return sorted(
        name for name in _settings_fields() if name.upper() not in documented
    )


def _default_for(name: str, field: object) -> str:
    if _SECRET_HINT.search(name):
        return ""
    default = getattr(field, "default", None)
    if default is None or repr(default) == "PydanticUndefined":
        factory = getattr(field, "default_factory", None)
        if factory is None:
            return ""
        try:
            default = factory()
        except Exception:  # pragma: no cover - defensive
            return ""
    if isinstance(default, bool):
        return "true" if default else "false"
    if isinstance(default, (list, tuple)):
        return ",".join(str(v) for v in default)
    return "" if default is None else str(default)


def emit_missing() -> str:
    fields = _settings_fields()
    comments = _field_comments()
    lines: list[str] = []
    for name in missing_settings():
        lines.extend(comments.get(name, []))
        lines.append(f"# {name.upper()}={_default_for(name, fields[name])}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n" if lines else ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emit", action="store_true", help="print the missing block")
    args = parser.parse_args()

    gaps = missing_settings()
    if args.emit:
        sys.stdout.write(emit_missing())
        return 0
    if gaps:
        print(f"{len(gaps)} setting(s) missing from .env.example:", file=sys.stderr)
        for name in gaps:
            print(f"  {name.upper()}", file=sys.stderr)
        print("\nRun with --emit to get a ready-to-paste block.", file=sys.stderr)
        return 1
    print(f"all {len(_settings_fields())} settings documented")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

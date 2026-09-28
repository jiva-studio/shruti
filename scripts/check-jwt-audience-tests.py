"""Every service that verifies the auth service's tokens must prove, in its own
tests, that a refresh token (aud="auth") is refused where an access token
(aud="chat") is expected. A service verifies tokens when its go.mod requires
golang-jwt or its pyproject.toml requires PyJWT.

The proof is a test, not a mention: a Go `func Test…` whose name says a refresh
token is rejected, or a case named "refresh aud=auth" inside a Go test
function, or a Python `def test_…` named the same way. Comments are not read.

Standard library only; run with `uv run --no-project python` or python3.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

SERVICES = Path(__file__).resolve().parents[1] / "modules" / "services"

NAME = re.compile(r"Refresh\w*Reject|Reject\w*Refresh", re.IGNORECASE)
PY_NAME = re.compile(r"audience_auth_rejected|refresh\w*reject|reject\w*refresh", re.IGNORECASE)
CASE = re.compile(r"refresh aud=auth", re.IGNORECASE)
GO_TEST_FUNC = re.compile(r"\bfunc\s+(Test\w*)\s*\(")


def lex_go(src: str) -> tuple[str, list[tuple[int, str]]]:
    """Source with comments and string contents blanked, plus each string literal."""
    code: list[str] = []
    strings: list[tuple[int, str]] = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if src.startswith("//", i):
            end = src.find("\n", i)
            end = n if end == -1 else end
            code.append(" " * (end - i))
            i = end
        elif src.startswith("/*", i):
            end = src.find("*/", i + 2)
            end = n if end == -1 else end + 2
            code.append("".join(c if c == "\n" else " " for c in src[i:end]))
            i = end
        elif ch in "\"'`":
            j = i + 1
            while j < n and src[j] != ch:
                j += 2 if ch != "`" and src[j] == "\\" else 1
            end = min(j + 1, n)
            strings.append((i, src[i + 1 : end - 1]))
            code.append(ch + "".join(c if c == "\n" else " " for c in src[i + 1 : end - 1]) + ch)
            i = end
        else:
            code.append(ch)
            i += 1
    return "".join(code), strings


def body_end(code: str, start: int) -> int:
    """Index just past the brace block that opens at or after `start`."""
    open_at = code.find("{", start)
    if open_at == -1:
        return len(code)
    depth = 0
    for k in range(open_at, len(code)):
        if code[k] == "{":
            depth += 1
        elif code[k] == "}":
            depth -= 1
            if depth == 0:
                return k + 1
    return len(code)


def go_proves(path: Path) -> bool:
    code, strings = lex_go(path.read_text(encoding="utf-8"))
    for m in GO_TEST_FUNC.finditer(code):
        if NAME.search(m.group(1)):
            return True
        end = body_end(code, m.end())
        if any(m.start() < pos < end and CASE.search(text) for pos, text in strings):
            return True
    return False


def py_proves(path: Path) -> bool:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name.startswith("test_")
        and PY_NAME.search(node.name)
        for node in ast.walk(tree)
    )


def verifies_jwt(svc: Path) -> bool:
    gomod = svc / "go.mod"
    if gomod.is_file() and "golang-jwt" in gomod.read_text(encoding="utf-8"):
        return True
    for pyproject in (svc / "app" / "pyproject.toml", svc / "pyproject.toml"):
        if pyproject.is_file() and "pyjwt" in pyproject.read_text(encoding="utf-8").lower():
            return True
    return False


def proves(svc: Path) -> bool:
    skip = {"node_modules", ".venv", ".git"}
    for path in svc.rglob("*"):
        if skip.intersection(path.parts) or not path.is_file():
            continue
        if path.name.endswith("_test.go") and go_proves(path):
            return True
        if path.name.startswith("test_") and path.suffix == ".py" and py_proves(path):
            return True
    return False


def main() -> int:
    checked = 0
    missing = 0
    for svc in sorted(p for p in SERVICES.iterdir() if p.is_dir()):
        if not verifies_jwt(svc):
            continue
        checked += 1
        if not proves(svc):
            print(f'✗ {svc.name} verifies JWTs but has no test refusing a refresh token (aud="auth")')
            missing += 1
    if missing:
        return 1
    print(f'jwt audience tests: {checked} verifier services, each refuses aud="auth"')
    return 0


if __name__ == "__main__":
    sys.exit(main())

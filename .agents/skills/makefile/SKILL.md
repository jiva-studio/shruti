---
name: makefile
description: Manage, edit, and execute targets in the root Makefile following the project conventions.
---

# Makefile Management & Execution Skill

The root `Makefile` is the one entry point for gates, builds and local stacks.
`make help` lists every target with its description.

## Gates

- `check` — every gate: `check-architecture`, `check-doc-make-targets`,
  `check-doc-links`, `check-jwt-audience-tests`, `check-chat`, `check-go`,
  `check-mobile`, `check-kit`, `check-web`.
- `check-package PKG=<path>` — the full gate for one package, chosen by the
  nearest `go.mod`, `pyproject.toml` or `package.json`
  ([`scripts/package-gate.sh`](../../../scripts/package-gate.sh)). `PKG` may be a
  path or a short name (`auth`, `mobile`, `chat`, `pipeline`).
- `test-package PKG=<path>` — that package's tests only.
- `test-package-red PKG=<path>` — the red phase: exits 0 only if the package
  resolves and its tests run and fail. `PKG=@task` is the active band task's
  `done.yaml` target ([`scripts/band-task-target.sh`](../../../scripts/band-task-target.sh)).
- `coverage` / `coverage PKG=<path>` — coverage for chat (with its floors),
  mobile and every Go module, or for one package.
- `check-architecture` — test_layering, depguard, dependency-cruiser and the
  gate self-test ([`scripts/check-architecture.sh`](../../../scripts/check-architecture.sh)).
- `check-gate-fixtures` — the gate self-test alone
  ([`modules/tools/gate-fixtures/`](../../../modules/tools/gate-fixtures/manifest.json)).
- `check-doc-make-targets` — every `make <target>` in `AGENTS.md` and
  `.agents/` is a real target.
- `check-doc-links` — every relative link in `docs/`, `AGENTS.md` and
  `.agents/` resolves.
- `check-jwt-audience-tests` — every JWT-verifying service tests that a refresh
  token is refused.
- `check-chat`, `check-go`, `check-mobile`, `check-kit`, `check-web` — one stack.

## Mutation testing (mobile)

- `mutate-diff` — Stryker over the files this branch changed, against the merge
  base with main. Mandatory for every mobile change.
- `mutate-full` — the whole package. Hours; a developer machine, not CI.

## Mobile app

- `mobile-install`, `mobile` (browser, port 11001), `mobile-build` (debug APK),
  `mobile-build-ios`, `mobile-deploy`, `mobile-live`.

## End-to-end and native

- `e2e-install`, `e2e`, `e2e-all`, `e2e-report` — Playwright over the web build.
- `native-install`, `native-emulator`, `native-build`, `native`,
  `native-clock-reset` — Appium on an Android emulator.

## Local stack and tools

- `stack-setup`, `stack-up`, `stack-down`, `stack-restart`, `stack-status`,
  `stack-logs`, `stack-app` — docker compose backend.
- `transcriber-*`, `shruti-mcp-*` — local tools.

## Rules for editing the Makefile

1. Register every target in `.PHONY`.
2. Give every target a `## description` so `make help` lists it.
3. A gate recipe calls a script in `scripts/` when it has more than a line or
   two of logic; the script is runnable on its own.
4. Python scripts run through `$(PYTHON)` (`uv run --no-project python`, or
   `python3` where uv is absent).
5. Long, machine-saturating runs (mutation) go through
   `./scripts/shruti-run-alone` so parallel worktrees take turns.
6. A target named in `AGENTS.md` or `.agents/` must exist;
   `make check-doc-make-targets` enforces it.

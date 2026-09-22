---
name: makefile
description: Manage, edit, and execute targets in the root Makefile following the project conventions.
---

# Makefile Management & Execution Skill

This skill defines the standards for editing and using the repository root `Makefile`.

## Standard Targets

### Gates & Checks
- `check-architecture` — run universal architecture guard across TypeScript, Python, and Go.

### Mutation testing
- `mutate-diff` (or `mutate-diff PKG=mobile`) — run diff mutation testing against the merge base with main. The mandatory per-change mutation check.
- `mutate-full` (or `mutate-full PKG=mobile`) — mutate the entire package. Run on a developer machine, not in CI.

### Mobile App (Vue 3 + Ionic + Capacitor)
- `mobile-install` — install mobile app dependencies.
- `mobile` — run mobile app in browser (port 11001).
- `mobile-build` — build debug APK for Android.
- `mobile-build-ios` — build signed release IPA for iOS.
- `mobile-deploy` — build APK and install on connected device.
- `mobile-live` — live reload on device.

### End-to-End & Native Testing
- `e2e` / `e2e-all` — mobile Playwright E2E suite.
- `native-install` / `native-emulator` / `native-build` / `native` — native Android emulator suite.

### Backend Stack & Tools
- `stack-setup` / `stack-up` / `stack-down` / `stack-status` / `stack-logs` — local backend stack (docker compose).
- `transcriber-*` — transcriber service + MCP wrapper.
- `lectorium-mcp-*` — lectorium-mcp daemon.

## Rules for Editing the Makefile

1. **Declaration & Phony**
   - Always register all targets in `.PHONY`.
2. **Help Documentation**
   - Provide `## Help text` on target definitions so `make help` lists them.
3. **Run Alone Protocol**
   - Intensive gates and mutation tests run through `./scripts/lectorium-run-alone` to prevent concurrent machine exhaustion.

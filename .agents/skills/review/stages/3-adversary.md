---
name: adversary
description: Review Stage 3 — the dynamic half of the critic claim. Writes and runs tests that try to break the change, keeps them, and writes critic_review.json in band's schema.
---

# Stage 3: Adversary

**If the code can fail under some sequence of events, write the test that makes
it fail.** A bug is confirmed only by a test that fails against the current code.

## 1. Hypotheses

From the Stage 2 findings and the diff, pick one to three scenarios per risky
area:

- **Boundaries** — empty, one, huge; unicode, RTL, combining marks; malformed
  JSON; CRLF.
- **Ordering** — responses resolving out of order; rapid repeated triggers;
  teardown while a request is in flight; two devices syncing the same document.
- **Invariants** — an expired, revoked or wrong-audience token is refused; one
  account never sees another's rows; replaying a sync batch changes nothing.

## 2. Write the tests

Beside the code, in the package's own framework:

- Go: `*_test.go` in the package; `-race` for anything concurrent.
- Python (chat): `tests/` in `modules/services/chat/app`.
- TypeScript: `__tests__/` or `*.test.ts` beside the module (Vitest).

## 3. Run them

```bash
make test-package PKG=<pkg>
```

- **Fails** — the defect is confirmed. Record the failure trace and hand the test
  to the implementer; it stays as the regression test once fixed.
- **Passes** — the code resists that attack. Keep the test.

## 4. Write the critic verdict

Write `.agents/tasks/<slug>/artifacts/critic_review.json` with every confirmed
defect and every Stage 2 finding rated CRITICAL or HIGH:

```json
{
  "passed": false,
  "findings": [
    { "file": "path/from/repo/root", "line": 42, "issue": "what breaks, and the test that shows it", "fix": "the change that repairs it" }
  ]
}
```

`passed` is `true` only when there are no CRITICAL or HIGH findings. This is the
file band's `critic` claim reads with `runner: file`.

## Output

Stage 3 of the report in [`../SKILL.md`](../SKILL.md). The tests are handed to
Stage 4.

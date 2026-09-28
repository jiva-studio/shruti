---
name: bug-hunter
description: Review Stage 2 — the static half of the critic claim. Reads the diff and its blast radius for logic bugs, races, contract drift and security holes, each proven with a concrete failure scenario.
---

# Stage 2: Bug Hunt

A white-box search for **functional defects**: logic, races, regressions,
security. Formatting, naming and size are out of scope here — Stage 1 and the
linters own them.

Every finding carries a concrete *Given → When → Then*. "This could fail" is not
a finding.

## 1. Diff and blast radius

- The diff from "Resolving the target" in [`../SKILL.md`](../SKILL.md).
- Every caller of a changed function, every consumer of a changed type — across
  services, and on installed mobile clients for anything on the wire.

## 2. What to look for

### Sync, outbox and clocks
- A server change written to the log without comparing HLCs; a client applying
  rows without comparing HLCs; a cursor advanced before the write it covers.
- Two writers to the same document; a read outside the transaction that writes.

### Async and concurrency
- Out-of-order responses overwriting newer state; a missing cancellation or
  generation guard.
- An async continuation writing state after its owner is gone (component
  unmounted, user signed out, account switched).
- A trigger dropped while a run is in flight.
- Tasks or goroutines started and never awaited or cancelled.
- Read-then-write without a transaction or a unique constraint.
- A file replaced with a fixed temporary name, or without a lock.

### Security
- Token checks that skip `aud`, `exp` or revocation; a refresh token accepted as
  access.
- Permission checks that pass on an empty scope; one account's data reachable
  with another's token.
- Unbounded request bodies on public endpoints; retry or rate limits that reset
  on resend.
- `Math.random()` for anything secret.

### Error paths
- Swallowed errors; state mutated before the call that can fail.
- Inverted or partial conditions; missing default branches.

### Wire contracts
- A Go `omitempty` or Python optional field read on the client without a guard.
- A field renamed or removed that an installed build still reads.

### Reactivity (Vue)
- Destructured props or stores without `toRefs` / `storeToRefs`.
- Listeners, timers and observers without cleanup.
- A value captured once (passed by value to a composable) that should follow a
  prop.

## Output

Stage 2 of the report in [`../SKILL.md`](../SKILL.md), one card per defect. Each
defect also becomes a finding in `critic_review.json` (Stage 3 writes the file).

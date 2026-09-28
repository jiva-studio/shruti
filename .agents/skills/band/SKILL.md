---
name: band
description: Multi-agent pipeline orchestrator. Runs the stages of a band pipeline (standard, hardened, fast, docs) for a task with a validated .agents/tasks/<slug>/done.yaml, dispatching each stage to its role in .agents/agents/ and advancing only when the stage's claims pass. Trigger with "/band", "band", "orchestrate band", or "run band".
---

# Band Pipeline Orchestrator (`/band`)

`/band` is the third band step, after [`/intent`](../intent/SKILL.md) and
[`/spec`](../spec/SKILL.md). It takes a task whose `done.yaml` is valid and
drives it through the stages of the pipeline that `done.yaml` names, one role
per stage, until every claim is verified.

The methodology is [band](https://github.com/jiva-studio/band). Its engine
(`python -m band --hook`, the stop-hook that verifies claims automatically) is
not installed in this repository yet: its hook file is not in Claude Code's
`.claude/settings.json` format. Until it is, the lead agent plays the engine —
it runs each claim itself, exactly as the adapters below describe, and never
advances a stage on an agent's word.

```mermaid
flowchart TD
    Start["/band &lt;slug&gt;"] --> Load["1. Load done.yaml, intent.md, spec.md"]
    Load --> Stage["2. Dispatch the stage's role<br/>(.agents/agents/)"]
    Stage --> Verify{"3. Lead runs the stage's claims"}
    Verify -->|"fail"| Feedback["Return the exact failure to the role"] --> Stage
    Verify -->|"pass"| Next{"More stages?"}
    Next -->|"yes"| Stage
    Next -->|"no"| Gate["4. Gatekeeper: every claim in done.yaml"]
    Gate --> Handover["5. Handover to the user"]
```

## Pipelines

| Pipeline | Use for | Stages → role |
| :--- | :--- | :--- |
| `hardened` | sync, auth, billing, migrations, anything whose failure corrupts data on installed clients | red-phase → [test-author](../../agents/test-author.md), green-phase → [implementer](../../agents/implementer.md), mutation-gate → lead, adversarial-review → [adversarial-reviewer](../../agents/adversarial-reviewer.md), gatekeeper → [gatekeeper](../../agents/gatekeeper.md) |
| `standard` | regular features | red-phase → test-author, green-phase → implementer, gatekeeper → gatekeeper |
| `fast` | hotfixes, copy, styling, config | implementation → implementer, gatekeeper → gatekeeper |
| `docs` | documentation, rules, runbooks | authoring → lead, critic → [doc-critic](../../agents/doc-critic.md), gatekeeper → gatekeeper |

[`../../rules/process.md`](../../rules/process.md) says which work needs
`hardened`. Mutation testing is mandatory only for the mobile app — the only
package with a Stryker configuration — so `mutation-gate` applies when the
target is `modules/apps/mobile`, and is skipped with a stated reason otherwise.

## Stage boundaries

- **red-phase** may only touch test files (`tests/**`, `**/*.test.*`,
  `**/*.spec.*`, `**/*_test.go`, `**/test_*.py`, `**/__tests__/**`). It proves
  the new tests fail: `make test-package PKG=<target>` must exit non-zero, for
  the reason the test names.
- **green-phase** may not touch those files. `make check-package PKG=<target>`
  must exit 0.
- Check the boundary with `git diff --name-only` after each stage. A stage that
  crossed it is rejected and its out-of-bounds edits reverted.

## Claims and how the lead verifies them

| Claim `tool` | What the lead runs | Passes when |
| :--- | :--- | :--- |
| `make` | `make <target> <KEY=value …>` from the repository root | exit code equals `expect_exit` (default 0); with `expect: red`, exit is non-zero |
| `mutation` | `make mutate-diff PKG=<target>` | exit 0 and no survived mutant outside `artifacts/mutant_waivers.json` |
| `critic` | reads `.agents/tasks/<slug>/artifacts/critic_review.json` written by the adversarial reviewer | `"passed": true` |
| `hygiene` | `git diff HEAD` added lines | no `TODO`/`FIXME`, no `Not implemented` stub, no `.skip`/`xit`/`xdescribe`, no `t.Skip`, no `pytest.mark.skip` |

`critic_review.json` has band's schema:

```json
{
  "passed": false,
  "findings": [
    { "file": "modules/services/auth/internal/jwt/jwt.go", "line": 199, "issue": "…", "fix": "…" }
  ]
}
```

## The gatekeeper stage

The last stage re-runs **every** claim in `done.yaml` on the final tree, plus
`make check-architecture`. Nothing cached from an earlier stage counts. The
pipeline is complete only when all of them pass in one run.

## Pausing

When the user needs to answer a question or give feedback, stop between stages
and say which stage is next. Resume from that stage; do not re-run passed stages
unless the tree changed under them.

## Handover

Report, for every claim: the command, its exit code, and the tail of its output
on failure. Then the diff summary. Merging is the user's decision.

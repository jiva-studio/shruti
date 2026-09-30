# Process: Working with Band

shruti follows the [band](https://github.com/jiva-studio/band) methodology: a
task goes `/intent` → `/spec` → `/band` (or `/coder` for single-agent work), its
artifacts live in `.agents/tasks/<slug>/`, and a task is done when every claim in
its `done.yaml` passes. This rule says what is shruti-specific about that.

The `/intent`, `/spec` and `/band` skills and the band engine (its stop-hook and
FSM) are not files in this repository: band's `install.sh` and
`sh .agents/bin/band --init` install them and merge the hooks into
`.agents/settings.json`. The engine is invoked as `sh .agents/bin/band <args>`
(`--validate-intent`, `--validate`, `--start-pipeline`, `--status`) and runs the
pipelines in [`../pipelines/`](../pipelines/). Without it the lead agent runs
each claim itself, as §4 describes, and never advances a stage on an agent's
word.

---

## 1. Task artifacts

```text
.agents/tasks/<slug>/
├── intent.md        # /intent: why, non-goals, failure modes, invariants — no code
├── spec.md          # /spec: prior art, interfaces, blast radius, acceptance criteria
├── done.yaml        # /spec: the pipeline and the claims that define done
└── artifacts/
    ├── critic_review.json    # adversarial reviewer's verdict, band's schema
    └── mutant_waivers.json   # equivalent mutants band's mutation claim ignores (§4)
```

Task folders are local: `.agents/.gitignore` keeps them out of git, and the
commit message and the PR carry the summary.

## 2. Prior art before the plan

No spec is written, and no spec is reviewed, before someone has looked outside
this repository: how the problem is already solved, where the field has moved,
which failure modes others have paid for. Three to six recent sources, each with
a link and one line, open `intent.md` (product level) and `spec.md` (technical
level). Name the approach adopted and the one rejected, with the reason.

The intent interview always asks what happens to installed mobile clients:
their local database, sync cursors, outbox and issued tokens. The spec has a
**Compatibility** section saying why they keep working (architecture.md §2), and
its blast radius lists every consumer of what changes, installed clients and
services reading the same stream or database included.

## 3. Choosing the pipeline

| Pipeline | When |
|---|---|
| `hardened` | the sync engine and the server-side sync endpoints; the outbox, HLC and conflict resolution; migrations in either database; auth, tokens, permissions and scopes; billing and entitlements |
| `standard` | ordinary features and fixes |
| `fast` | copy, styling, config, a one-line fix whose failure is visible on sight |
| `docs` | documentation, rules, runbooks |

The test is "if this is wrong, when do we find out?" Defects that surface on the
screen can be carried by one agent. Defects that surface as a corrupted row on
someone's device three syncs later cannot.

## 4. Stages and claims

Roles are the stages of the pipelines in [`../pipelines/`](../pipelines/); each
stage's `role` and `directive` say what it does. The red phase touches only the
files its `allow` lists and the green phase none of its `forbid_edits`; after
each stage `git diff --name-only` checks the boundary, and out-of-bounds edits
are reverted. An implementer that finds a test wrong says so and waits; an
adversarial reviewer adds tests but never fixes production code.

The pipelines pass `PKG=@task`, which
[`scripts/band-task-target.sh`](../../scripts/band-task-target.sh) resolves to the
`target` of the task's `done.yaml`; run by hand, pass that target instead.
`done.yaml` has a `check-package` claim for every package in the blast radius,
not only its `target`, and a `mutation` claim (`target: "modules/apps/mobile"`,
`mode: diff`) whenever the mobile app is in it.

| Claim `tool` | Command | Passes when |
|---|---|---|
| `make` | `make <target> <KEY=value …>` from the repository root | exit equals `expect_exit` (default 0) |
| `mutation` | `make mutate-diff PKG=<target>` | exit 0 (score over the changed files at least the `break` threshold in `stryker.config.json`); under the engine, also no `Survived` line other than those waived |
| `critic` | read `artifacts/critic_review.json` | `"passed": true` |
| `hygiene` | the hygiene grep in [review Stage 0](../skills/review/stages/0-completeness.md#2-hygiene) | no hit |

`critic_review.json` uses band's schema. `passed` is `true` only with no
CRITICAL or HIGH finding, and each finding is backed by a failing test:

```json
{ "passed": false, "findings": [ { "file": "path/from/repo/root", "line": 42, "issue": "what breaks, and the test that shows it", "fix": "the change that repairs it" } ] }
```

### Mutant waivers

`artifacts/mutant_waivers.json` lists equivalent mutants as substrings of
Stryker's `Survived` lines:

```json
{ "waived_mutants": ["<substring of the Stryker Survived line>"] }
```

Band's `mutation` claim drops matching lines before failing on survivors;
`make mutate-diff` never reads the file, and a waiver cannot rescue a run that
exits non-zero. Each waiver's reason goes in `critic_review.json`.

The gatekeeper stage re-runs every claim on the final tree in one pass, plus the
gates in §6. Files in no package (docs, workflows, root scripts) are gated by
`make check-doc-make-targets` and `make check-doc-links`.

## 5. What is frozen first

The contract — types, wire shapes and fixtures — is written once, before any
implementation starts, and changes only when every agent on the task is told.
Fixtures move with types.

## 6. What must be proven before handing over

Evidence, not belief:

1. **Every claim in `done.yaml` passes** in one run on the final tree, with the
   command and exit code shown. At minimum `make check-package PKG=<target>` for
   each package touched and `make check-architecture`.
2. **Every new test is mutation-checked by hand**: break the property it
   defends, see it go red, revert.
3. **For the mobile app, `make mutate-diff` passes.** It is the one package with
   a Stryker configuration, and the claim is mandatory there. Other packages rely
   on step 2.

An agent that cannot produce all of these says so and names what is missing.

## 7. What stays with the human

An agent prepares these, explains them, and asks:

- **Permissions and scopes** — anything in auth, any change to what a token or a
  role can reach.
- **Migrations**, in the server schema and in the client store.
- **The wire contract** — anything that changes what a deployed version sends to
  another, including SSE events and preference keys.
- **Dependencies** — adding, removing or upgrading a package.
- **Data repair** on production.

Their blast radius is not contained by the branch: a wrong answer reaches data
already in the world or a client already installed.

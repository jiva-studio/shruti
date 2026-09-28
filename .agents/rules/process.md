# Process: Working with Band

shruti follows the [band](https://github.com/jiva-studio/band) methodology: a
task goes `/intent` → `/spec` → `/band` (or `/coder` for single-agent work), its
artifacts live in `.agents/tasks/<slug>/`, and a task is done when every claim in
its `done.yaml` passes. This rule says what is shruti-specific about that.

The band engine (its stop-hook and FSM) is not installed here yet; the lead
agent runs each claim itself, as [`/band`](../skills/band/SKILL.md) describes.
Once jiva-studio/band#6 is merged it is installed with band's `install.sh` and
`sh .agents/bin/band --init`, which merges its hooks into
`.agents/settings.json`; it is invoked as `sh .agents/bin/band <args>` and runs
the pipelines in [`../pipelines/`](../pipelines/).

---

## 1. Task artifacts

```text
.agents/tasks/<slug>/
├── intent.md        # /intent: why, non-goals, failure modes, invariants — no code
├── spec.md          # /spec: prior art, interfaces, blast radius, acceptance criteria
├── done.yaml        # /spec: the pipeline and the claims that define done
└── artifacts/
    ├── critic_review.json    # adversarial reviewer's verdict, band's schema
    └── mutant_waivers.json   # equivalent mutants band's mutation claim ignores (see /band)
```

Task folders are committed with the change they describe and removed once it has
merged; the commit message and the PR carry the summary.

## 2. Prior art before the plan

No spec is written, and no spec is reviewed, before someone has looked outside
this repository: how the problem is already solved, where the field has moved,
which failure modes others have paid for. Three to six recent sources, each with
a link and one line, open `intent.md` (product level) and `spec.md` (technical
level). Name the approach adopted and the one rejected, with the reason.

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

## 4. Roles

The roles live in [`.agents/agents/`](../agents/):

- **[test-author](../agents/test-author.md)** turns acceptance criteria into
  tests, proves them red, and owns the test files.
- **[implementer](../agents/implementer.md)** takes the tests to green without
  touching them. If a test looks wrong it says so and waits.
- **[adversarial-reviewer](../agents/adversarial-reviewer.md)** tries to break
  the change, proves each finding with a failing experiment, and never fixes.
- **[gatekeeper](../agents/gatekeeper.md)** re-runs every claim on the final
  tree.
- **[doc-critic](../agents/doc-critic.md)** reviews documentation against the
  code it describes.

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

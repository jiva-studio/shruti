# Working in Bands

A **band** is one unit of work carried by one or more agents on one branch. This
rule says who does what inside a band, what gets frozen first, and what an agent
has to prove before it hands the band over.

---

---

## 1. Prior art before the plan

No plan is written, and no plan is reviewed, before someone has looked outside
this repository. Before a spec is drafted and before a spec or a design is
grilled, search the web for how the problem is already solved: what the
established approach is, where the field has moved, and which failure modes
other people have already paid for.

The result is a short **Prior art** block — three to six sources, recent, each
with a link and one line on what it says — and it opens the plan, above the
options. A spec or a review that does not carry one is not ready to be read.

Its job is to constrain the options, not to decorate them: name the approach
being adopted, and name the one being rejected together with the reason.

## 2. Roles

### Test agent

- Derives the acceptance criteria from the spec and turns each one into a test.
- **Writes the tests red first** and proves they are red: the failing output goes
  into the handover. A test that has never failed has not been shown to test
  anything.
- **Owns the test files.** They are its output, and nobody else edits them.

### Implementation agent

- Takes the red tests to green.
- **Does not touch the test files.** If a test looks wrong — wrong expectation,
  wrong fixture, wrong criterion — it says so and waits. Editing the test to
  match the implementation destroys the only independent check in the band.
- Writes its own narrow unit tests for internals it introduces. Those are its
  files; the acceptance tests are not.

### Adversarial reviewer

- **Mandate: break it.** Not to confirm it works — to find where it does not.
- **Obligation: prove it.** A finding is a failing experiment — a test, a
  command, a transcript — not a suspicion. "This looks racy" is not a finding;
  a spec that fails under two concurrent writers is.
- **No right to fix.** The reviewer reports. Whoever owns the file repairs it.
  A reviewer that patches its own findings has reviewed nothing.

---

## 3. When to split the band

Split across agents where the cost of a mistake is high and an independent
checker earns its overhead:

- the sync engine, the server-side sync endpoints;
- anything touching the outbox, the HLC, or conflict resolution;
- database migrations, in either system;
- permission and scope evaluation.

One agent is enough for interface components, copy, formatting, config changes
and anything whose failure is visible the moment you look at it.

The test is not "how big" but "if this is wrong, when do we find out?" Code whose
defects surface on the screen can be carried by one agent. Code whose defects
surface as a corrupted row on someone's device three syncs later cannot.

---

## 4. What is frozen first

**The contract — types and fixtures — is written by one agent before any
implementation starts.** It is the shape every other agent codes against.

Once it is in:

- nobody edits it alone;
- a change to it is announced to every agent on the band before it lands;
- **fixtures move with types.** A type changed without its fixtures leaves every
  other agent compiling against one shape and testing against another, and the
  mismatch shows up as someone else's failing test.

---

## 5. What an agent must prove before handing over

Not "I believe it works". Evidence, in the handover:

1. **The gate is green.** The full gate for the area touched, with the command
   and its exit shown. A partial gate is not a gate.
2. **Every new test is mutation-checked by hand.** For each one: break the
   property the test defends, confirm the test goes red, revert. A test that
   still passes with the behaviour removed defends nothing, and it is cheaper to
   find that out now than after it has guarded a regression for a month.
3. **The mutation score on the diff has not dropped.** `make mutate-diff` passes
   its threshold. New code that the suite does not actually exercise is not done.

An agent that cannot produce all three says so plainly and names what is missing.
Reporting a band as complete when it is not is the one failure that costs more
than the defect.

---

## 6. What stays with the human

An agent does not decide these alone. It prepares the change, explains it, and
asks:

- **Permissions and scopes** — anything under `auth/`, any change to what a role
  can reach.
- **Migrations**, in both the server schema and the client store.
- **The wire contract** — anything that changes what one deployed version sends
  to another.
- **Dependencies** — adding, removing or upgrading a package.

These have in common that the blast radius is not contained by the branch: a
wrong answer reaches data that is already in the world, or a client that is
already installed.

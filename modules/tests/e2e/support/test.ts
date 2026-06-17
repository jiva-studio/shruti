import { test as base, expect } from "@playwright/test"
import { fixturesReady, missingFixtures } from "./fixtures.js"

/**
 * Shared test object for the suite. Every spec imports `test`/`expect` from here
 * (not from `@playwright/test`) so the fixture guard below applies uniformly.
 *
 * The suite needs gitignored binary fixtures (catalog + seeded user DBs). When
 * they're absent — e.g. a plain CI checkout that hasn't run prepare-fixtures —
 * we SKIP rather than fail, so the kit auto `e2e` job stays green. The real runs
 * happen locally and in the dedicated `e2e (manual)` workflow, which prepares
 * the fixtures first.
 */
export const test = base

test.beforeEach(() => {
  test.skip(
    !fixturesReady(),
    `E2E fixtures not prepared (${missingFixtures().join(", ")}). ` +
      `Run scripts/prepare-fixtures.sh or the "e2e (manual)" workflow.`
  )
})

export { expect }

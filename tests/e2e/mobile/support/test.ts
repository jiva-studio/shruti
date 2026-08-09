import { test as base, expect } from "@playwright/test"
import { fixturesReady, missingFixtures } from "./fixtures.js"
import { installNetworkGuard } from "./network-guard.js"
import { installDefaultAnonymousAuth } from "./chat-mock.js"
import { installProfileSyncMock } from "./sync-mock.js"

/**
 * Shared test object for the suite. Every spec imports `test`/`expect` from here
 * (not from `@playwright/test`) so the fixture guard below applies uniformly.
 *
 * The suite needs gitignored binary fixtures (catalog + seeded user DBs). When
 * they're absent — e.g. a plain CI checkout that hasn't run prepare-fixtures —
 * we SKIP rather than fail, so the kit auto `e2e` job stays green. The real runs
 * happen locally and in the dedicated `e2e (manual)` workflow, which prepares
 * the fixtures first.
 *
 * The auto `offlinePosture` fixture is what keeps the suite offline for every
 * spec rather than for the ones that remembered to ask:
 *   1. the network guard blocks anything that would leave the machine, and
 *      fails the test when it was aimed at production (`network-guard.ts`),
 *   2. `POST /auth/anonymous` gets a canned session, so no spec can mint a real
 *      account (`chat-mock.ts`),
 *   3. `**​/profile/sync/*` gets a deterministic empty answer (`sync-mock.ts`).
 *
 * All three are CONTEXT-level routes, which Playwright matches after page-level
 * ones — so a spec's own `page.route` still overrides any of them. Registration
 * order matters within the context: the guard goes first so the later, more
 * specific mocks are consulted before it.
 */
export const test = base.extend<{ offlinePosture: void }>({
  offlinePosture: [
    async ({ context }, use, testInfo) => {
      // `@live` drives a real (local) stack on purpose — no guard, no mocks.
      if (testInfo.tags.includes("@live")) {
        await use()
        return
      }
      const guard = await installNetworkGuard(context, testInfo)
      await installDefaultAnonymousAuth(context)
      await installProfileSyncMock(context)
      await use()
      guard.assertNoProductionTraffic()
    },
    { auto: true },
  ],
})

/**
 * Skip the current test when the gitignored binary fixtures (catalog + seeded
 * user DBs) aren't prepared — e.g. a plain CI checkout — so the kit auto `e2e`
 * job stays green instead of erroring. Called at the top of the entry helpers
 * (`interceptContent` / `bootLive`) rather than from a `beforeEach`, so it does
 * NOT surface as a "Before Hooks" step in the Qase report.
 */
export function requireFixtures(): void {
  test.skip(
    !fixturesReady(),
    `E2E fixtures not prepared (${missingFixtures().join(", ")}). ` +
      `Run scripts/prepare-fixtures.sh or the "e2e (manual)" workflow.`
  )
}

export { expect }

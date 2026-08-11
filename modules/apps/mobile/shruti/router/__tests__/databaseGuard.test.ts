import { describe, expect, it } from "vitest"

import { resolveDatabaseRedirect, STORAGE_ERROR_PATH } from "../databaseGuard.js"

/**
 * The guard that produced the inescapable onboarding loop (#1724).
 *
 * A user DB that fails to open is a state `services/startup.ts` reaches on
 * purpose (`ready === true`, `databases.user === null`). The old guard sent
 * every route to `/onboarding`, whose `finish()` replaces to `/tabs/home` —
 * which the guard bounced straight back. Nothing on screen said why, and the
 * only exit was a reinstall.
 *
 * The invariants below are what makes that impossible: the failure has its own
 * terminal route, and that route is never itself redirected.
 */
describe("resolveDatabaseRedirect", () => {
  const open = { initialized: true, content: true, user: true }
  const userDbDead = { initialized: true, content: true, user: false }

  it("lets every route through when both databases are open", () => {
    for (const path of ["/tabs/home", "/tabs/notes", "/tabs/track/t1", "/onboarding", "/"]) {
      expect(resolveDatabaseRedirect(path, open)).toBeNull()
    }
  })

  it("sends tabs routes to the storage-error screen when the user DB is missing", () => {
    expect(resolveDatabaseRedirect("/tabs/home", userDbDead)).toBe(STORAGE_ERROR_PATH)
    expect(resolveDatabaseRedirect("/tabs/notes", userDbDead)).toBe(STORAGE_ERROR_PATH)
  })

  it("sends tabs routes to the storage-error screen when the content DB is missing", () => {
    const contentDead = { initialized: true, content: false, user: true }
    expect(resolveDatabaseRedirect("/tabs/home", contentDead)).toBe(STORAGE_ERROR_PATH)
  })

  it("never redirects the storage-error screen itself — that was the loop", () => {
    expect(resolveDatabaseRedirect(STORAGE_ERROR_PATH, userDbDead)).toBeNull()
    expect(resolveDatabaseRedirect(STORAGE_ERROR_PATH, open)).toBeNull()
    expect(
      resolveDatabaseRedirect(STORAGE_ERROR_PATH, {
        initialized: true,
        content: false,
        user: false,
      })
    ).toBeNull()
  })

  it("no longer bounces a broken user DB into onboarding", () => {
    // The old behaviour. `/onboarding` finishes by replacing to /tabs/home, so
    // routing a dead user DB there is what closed the circle.
    expect(resolveDatabaseRedirect("/tabs/home", userDbDead)).not.toBe("/onboarding")
  })

  it("stays out of the way before the composition root exists", () => {
    // `router.install()` navigates immediately, before `initShruti` has
    // necessarily run in a non-app context (tests, storybook).
    expect(
      resolveDatabaseRedirect("/tabs/home", { initialized: false, content: false, user: false })
    ).toBeNull()
  })
})

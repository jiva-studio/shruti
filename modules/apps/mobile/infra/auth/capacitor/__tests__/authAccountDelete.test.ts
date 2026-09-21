import { describe, expect, it } from "vitest"

import { AccountDeleteError } from "@ports/app/auth.js"

import { type AccountDeleteDeps, createDeleteAccount } from "../authAccountDelete.js"

const response = (status: number): Response =>
  new Response(null, { status: status === 204 ? 204 : status })

interface Harness {
  readonly deleteAccount: () => Promise<void>
  readonly posts: Array<{ token: string | undefined }>
  /** null once the session's tokens have been dropped. */
  session: { userId: string; accessToken: string } | null
  refreshedTo: { userId: string; accessToken: string } | null
}

/**
 * A delete bound to a live session. `statuses` are served one per POST, the
 * last one repeating; a number 0 stands for a transport that throws.
 */
function makeHarness(
  statuses: readonly number[],
  overrides: { refreshTo?: { userId: string; accessToken: string } | null } = {}
): Harness {
  const h: Harness = {
    deleteAccount: async () => {},
    posts: [],
    session: { userId: "user-1", accessToken: "access-1" },
    refreshedTo:
      overrides.refreshTo === undefined
        ? { userId: "user-1", accessToken: "access-2" }
        : overrides.refreshTo,
  }

  let i = 0
  const deps: AccountDeleteDeps = {
    request: async (path, init) => {
      expect(path).toBe("/account/delete")
      const headers = (init?.headers ?? {}) as Record<string, string>
      h.posts.push({ token: headers.Authorization })
      const status = statuses[Math.min(i++, statuses.length - 1)]
      if (status === 0) throw new TypeError("Failed to fetch")
      return response(status)
    },
    currentUserId: () => h.session?.userId ?? null,
    currentAccessToken: () => h.session?.accessToken ?? null,
    getAccessToken: async () => {
      if (!h.refreshedTo) return null
      h.session = h.refreshedTo
      return h.refreshedTo.accessToken
    },
    clearTokens: async () => {
      h.session = null
    },
  }

  return Object.assign(h, { deleteAccount: createDeleteAccount(deps) })
}

const bearers = (h: Harness): Array<string | undefined> => h.posts.map((p) => p.token)

describe("createDeleteAccount", () => {
  it("drops local tokens once the server confirms", async () => {
    const h = makeHarness([200])

    await expect(h.deleteAccount()).resolves.toBeUndefined()

    expect(h.session).toBeNull()
    expect(bearers(h)).toEqual(["Bearer access-1"])
  })

  it("accepts an empty 204 as confirmation", async () => {
    const h = makeHarness([204])

    await h.deleteAccount()

    expect(h.session).toBeNull()
  })

  it("does nothing at all when there is no session to delete", async () => {
    const h = makeHarness([200])
    h.session = null

    await expect(h.deleteAccount()).resolves.toBeUndefined()

    expect(h.posts).toHaveLength(0)
  })

  it("keeps local data when the request never reaches the server", async () => {
    const h = makeHarness([0])

    const err = await h.deleteAccount().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AccountDeleteError)
    expect((err as AccountDeleteError).kind).toBe("network")
    // The account still exists, so a wipe here would lose notes and downloads
    // from an account the user can still sign back into.
    expect(h.session).not.toBeNull()
  })

  it("keeps local data when the server faults", async () => {
    const h = makeHarness([503])

    const err = await h.deleteAccount().catch((e: unknown) => e)

    expect((err as AccountDeleteError).kind).toBe("server")
    expect((err as AccountDeleteError).status).toBe(503)
    expect(h.session).not.toBeNull()
  })

  it("keeps local data when the delete is rate-limited", async () => {
    const h = makeHarness([429])

    const err = await h.deleteAccount().catch((e: unknown) => e)

    expect((err as AccountDeleteError).kind).toBe("rate-limited")
    expect(h.session).not.toBeNull()
  })

  it("drops local tokens for an account the server has already deleted", async () => {
    const h = makeHarness([410])

    const err = await h.deleteAccount().catch((e: unknown) => e)

    expect((err as AccountDeleteError).kind).toBe("already-deleted")
    // Nothing left to protect — the caller's wipe should land on a clean slate.
    expect(h.session).toBeNull()
  })

  it("refreshes a stale access token and retries once", async () => {
    const h = makeHarness([401, 200])

    await h.deleteAccount()

    expect(bearers(h)).toEqual(["Bearer access-1", "Bearer access-2"])
    expect(h.session).toBeNull()
  })

  it("does not retry a second time when the refreshed token is refused too", async () => {
    const h = makeHarness([401, 401])

    const err = await h.deleteAccount().catch((e: unknown) => e)

    expect((err as AccountDeleteError).kind).toBe("unauthorized")
    expect(h.posts).toHaveLength(2)
    expect(h.session).not.toBeNull()
  })

  it("gives up unauthorized when no token can be refreshed", async () => {
    const h = makeHarness([401], { refreshTo: null })

    const err = await h.deleteAccount().catch((e: unknown) => e)

    expect((err as AccountDeleteError).kind).toBe("unauthorized")
    expect((err as AccountDeleteError).status).toBe(401)
    expect(h.posts).toHaveLength(1)
  })

  it("refuses to retry against an account the session was swapped to", async () => {
    const h = makeHarness([401, 200], {
      refreshTo: { userId: "user-2", accessToken: "access-2" },
    })

    const err = await h.deleteAccount().catch((e: unknown) => e)

    // Retrying here would delete whoever signed in between the two posts.
    expect((err as AccountDeleteError).kind).toBe("unauthorized")
    expect(h.posts).toHaveLength(1)
    expect(h.session?.userId).toBe("user-2")
  })

  it("reports a network failure on the retry, not a false success", async () => {
    const h = makeHarness([401, 0])

    const err = await h.deleteAccount().catch((e: unknown) => e)

    expect((err as AccountDeleteError).kind).toBe("network")
    expect(h.session).not.toBeNull()
  })
})

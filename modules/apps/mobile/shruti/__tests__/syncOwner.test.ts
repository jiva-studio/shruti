import { describe, expect, it } from "vitest"
import { createOwnerIdProvider } from "../syncOwner.js"

/**
 * Guards the attribution of rows journaled while no session exists (#1497).
 *
 * `signOut()` and `deleteAccount()` both run `applySession(null)` and then
 * `await restore()` — a network round-trip to `/auth/anonymous`. Writes do not
 * pause for it: the listening tracker finishes a session every 15 s during
 * playback. A `null` stamp there would leave those rows unattributed, and the
 * identity change that follows retires unattributed rows wholesale.
 */
describe("createOwnerIdProvider", () => {
  it("reports the current session's account", () => {
    let userId: string | null = "user-1"
    const getOwnerId = createOwnerIdProvider(() => userId)

    expect(getOwnerId()).toBe("user-1")
    userId = "user-2"
    expect(getOwnerId()).toBe("user-2")
  })

  it("holds the outgoing account across the session-less bootstrap window", () => {
    let userId: string | null = "user-1"
    const getOwnerId = createOwnerIdProvider(() => userId)
    expect(getOwnerId()).toBe("user-1")

    // applySession(null) — the anonymous restore is still in flight.
    userId = null
    expect(getOwnerId()).toBe("user-1")
    expect(getOwnerId()).toBe("user-1")

    // The bootstrap lands; everything after this is the new identity's.
    userId = "anon-2"
    expect(getOwnerId()).toBe("anon-2")
  })

  it("attributes the window to the account leaving, never the one arriving", () => {
    // The direction matters: a row misattributed to the outgoing account is
    // retired with the rest of its history, while one misattributed to the
    // incoming account would upload to a stranger — the #1497 defect itself.
    let userId: string | null = "user-1"
    const getOwnerId = createOwnerIdProvider(() => userId)
    getOwnerId()

    userId = null
    const duringWipe = getOwnerId()
    userId = "anon-2"

    expect(duringWipe).toBe("user-1")
    expect(duringWipe).not.toBe("anon-2")
  })

  it("reports null only before any identity has ever been seen", () => {
    const getOwnerId = createOwnerIdProvider(() => null)
    expect(getOwnerId()).toBeNull()
  })
})

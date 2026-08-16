import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { AuthSession } from "@ports/app/auth.js"

/**
 * Sign-out hands the device to whoever picks up the phone next (#1773). The
 * user DB is device-wide, so the previous account's notes / playlist /
 * listening history / chat transcripts are readable by that person unless
 * sign-out wipes them — silently, because a confirmation on a handed-over
 * phone is answered by the wrong person.
 *
 * The carve-out is the identity that has nowhere to restore from: an unclaimed
 * anonymous session's rows only ever reached the anonymous uid, which nothing
 * can sign back into (#1650), so wiping there is pure deletion.
 */

const wipeLocalUserData = vi.fn().mockResolvedValue(undefined)
const flushPendingOutbox = vi.fn().mockResolvedValue({ stranded: false })
const clearPendingTurns = vi.fn().mockResolvedValue(undefined)
const authSignOut = vi.fn().mockResolvedValue(undefined)
const purchasesLogOut = vi.fn().mockResolvedValue(undefined)
const authInitialize = vi.fn<() => Promise<AuthSession | null>>()

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    userId: "u-1",
    email: "user@example.com",
    name: "User",
    picture: null,
    anonymous: false,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    tier: "free",
    tierExpiresAt: null,
    quotaId: "q1",
    ...over,
  }
}

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    auth: {
      signOut: authSignOut,
      initialize: authInitialize,
      onSessionChange: () => () => undefined,
      getSession: () => null,
      fetchMe: vi.fn(),
      refreshTokens: vi.fn(),
    },
    repositories: vi.fn(),
    filesStorage: { clearAll: vi.fn() },
    preferences: { remove: vi.fn() },
  }),
}))

vi.mock("@shruti/services/dataWipe.js", () => ({
  wipeLocalUserData: (...args: unknown[]) => wipeLocalUserData(...args),
}))

vi.mock("@shruti/services/outboxFlush.js", () => ({
  flushPendingOutbox: (...args: unknown[]) => flushPendingOutbox(...args),
}))

// The device-local "Sync chats" toggle decides whether the account holds a
// copy of the conversations the wipe destroys (#1883). Backed by preferences
// in production; here it is the switch the tests flip.
const syncChatsEnabled = ref(true)
vi.mock("@shruti/composables/useSyncChats.js", () => ({
  useSyncChatsEnabled: () => syncChatsEnabled,
}))

vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({ clearPendingTurns, resetComposeLock: vi.fn() }),
}))

vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ logOut: purchasesLogOut }),
}))

vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}))

import { useAuthStore } from "../useAuthStore.js"

/** Bring the store up on `first`, then answer the post-sign-out bootstrap. */
async function bootWith(first: AuthSession | null): Promise<ReturnType<typeof useAuthStore>> {
  authInitialize.mockResolvedValueOnce(first).mockResolvedValue(session({ anonymous: true }))
  const store = useAuthStore()
  await store.restore()
  return store
}

describe("useAuthStore.signOut", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    wipeLocalUserData.mockReset().mockResolvedValue(undefined)
    flushPendingOutbox.mockReset().mockResolvedValue(undefined)
    clearPendingTurns.mockReset().mockResolvedValue(undefined)
    authSignOut.mockReset().mockResolvedValue(undefined)
    purchasesLogOut.mockReset().mockResolvedValue(undefined)
    authInitialize.mockReset()
    flushPendingOutbox.mockResolvedValue({ stranded: false })
    syncChatsEnabled.value = true
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("wipes the device when a real account signs out", async () => {
    const store = await bootWith(session())
    expect(store.signedIn).toBe(true)

    await expect(store.signOut()).resolves.toMatchObject({ wiped: true })

    expect(authSignOut).toHaveBeenCalledOnce()
    expect(wipeLocalUserData).toHaveBeenCalledOnce()
    expect(clearPendingTurns).toHaveBeenCalledOnce()
  })

  it("spares the public catalog — the wipe is about the user's rows", async () => {
    const store = await bootWith(session())
    await store.signOut()

    // Nothing in the catalog is the signed-out user's, so dropping it would
    // buy no privacy and bill the next person a full re-download.
    expect(wipeLocalUserData.mock.calls[0]![1]).toEqual({ contentCatalog: "keep" })
  })

  it("flushes the outgoing account's outbox before the token is dropped", async () => {
    const order: string[] = []
    flushPendingOutbox.mockImplementation(() => {
      order.push("flush")
      return Promise.resolve()
    })
    authSignOut.mockImplementation(() => {
      order.push("signOut")
      return Promise.resolve()
    })
    wipeLocalUserData.mockImplementation(() => {
      order.push("wipe")
      return Promise.resolve()
    })

    const store = await bootWith(session())
    await store.signOut()

    // The push has to reach the server while the account's token is still
    // live, and the wipe empties the journal it drained.
    expect(order).toEqual(["flush", "signOut", "wipe"])
    expect(flushPendingOutbox.mock.calls[0]![0]).toMatchObject({ ownerId: "u-1" })
  })

  it("does NOT wipe when an unclaimed anonymous session signs out", async () => {
    const store = await bootWith(session({ userId: "anon-1", anonymous: true, email: null }))
    expect(store.signedIn).toBe(false)

    await expect(store.signOut()).resolves.toMatchObject({ wiped: false })

    expect(authSignOut).toHaveBeenCalledOnce()
    expect(wipeLocalUserData).not.toHaveBeenCalled()
    // Nothing to rescue either: the rows stay on the device, where they are
    // still the only copy their author can reach.
    expect(flushPendingOutbox).not.toHaveBeenCalled()
  })

  it("still drops to anonymous when the wipe fails", async () => {
    wipeLocalUserData.mockRejectedValueOnce(new Error("disk gone"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const store = await bootWith(session())
    await expect(store.signOut()).resolves.toMatchObject({ wiped: true })

    expect(warn).toHaveBeenCalled()
    // restore() ran: the initial bootstrap plus the one after sign-out.
    expect(authInitialize).toHaveBeenCalledTimes(2)
    expect(store.anonymous).toBe(true)
  })

  it("unbinds the entitlement before the session flips", async () => {
    const store = await bootWith(session())
    await store.signOut()

    // Ahead of the anonymous re-bootstrap: the next identity must never see
    // the departing account's Pro, and the RC identity watcher only clears
    // it on a successful SDK call — or not at all, if configure() threw
    // and the session has no watcher (#1829).
    expect(purchasesLogOut).toHaveBeenCalledOnce()
    expect(purchasesLogOut.mock.invocationCallOrder[0]!).toBeLessThan(
      authInitialize.mock.invocationCallOrder[1]!
    )
  })

  it("still drops to anonymous when the RC logOut rejects", async () => {
    purchasesLogOut.mockRejectedValueOnce(new Error("offline"))
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const store = await bootWith(session())
    await expect(store.signOut()).resolves.toMatchObject({ wiped: true })

    expect(store.anonymous).toBe(true)
  })

  it("a failing flush does not block the sign-out", async () => {
    flushPendingOutbox.mockRejectedValueOnce(new Error("offline"))
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const store = await bootWith(session())
    // …and the rows it could not deliver are reported as lost, not swallowed:
    // the wipe below deletes the device's only copy of them (#1883).
    await expect(store.signOut()).resolves.toMatchObject({ wiped: true, stranded: true })

    expect(authSignOut).toHaveBeenCalledOnce()
    expect(wipeLocalUserData).toHaveBeenCalledOnce()
  })

  describe("what the notice is allowed to claim (#1883)", () => {
    it("reports chat as recoverable only when chat sync was on", async () => {
      const store = await bootWith(session())
      await expect(store.signOut()).resolves.toMatchObject({ chatSynced: true })
    })

    it("reports chat as unrecoverable when chat sync was off", async () => {
      syncChatsEnabled.value = false
      const store = await bootWith(session())
      // Nothing was ever journaled, so `chat.clearAll()` in the wipe destroys
      // the only copy — the toast must not promise the conversations back.
      await expect(store.signOut()).resolves.toMatchObject({ chatSynced: false })
    })

    it("reads the toggle BEFORE the wipe", async () => {
      syncChatsEnabled.value = false
      // A wipe that reset preferences back to the default would otherwise make
      // the flag read `true` and hand the caller the reassuring message.
      wipeLocalUserData.mockImplementation(() => {
        syncChatsEnabled.value = true
        return Promise.resolve()
      })

      const store = await bootWith(session())
      await expect(store.signOut()).resolves.toMatchObject({ chatSynced: false })
    })

    it("passes through the stranded rows the farewell push left behind", async () => {
      flushPendingOutbox.mockResolvedValueOnce({ stranded: true })
      const store = await bootWith(session())
      await expect(store.signOut()).resolves.toMatchObject({ stranded: true })
    })

    it("claims no loss when the flush delivered everything", async () => {
      const store = await bootWith(session())
      await expect(store.signOut()).resolves.toMatchObject({ stranded: false })
    })

    it("claims no loss for an anonymous sign-out, which flushes nothing", async () => {
      const store = await bootWith(session({ userId: "anon-1", anonymous: true, email: null }))
      await expect(store.signOut()).resolves.toEqual({
        wiped: false,
        chatSynced: true,
        stranded: false,
      })
    })
  })
})

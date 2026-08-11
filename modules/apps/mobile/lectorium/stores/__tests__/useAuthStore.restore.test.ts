import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { AuthSession } from "@ports/app/auth.js"

/**
 * A first launch with no network makes `auth.initialize()` throw after its
 * bootstrap retries. What must survive that is the store's subscription to the
 * port: when the network returns, `getAccessToken()` self-heals and mints the
 * anonymous identity, and the only way that session reaches Pinia is
 * `onSessionChange`. Subscribing after the awaited bootstrap meant an offline
 * first launch left the store detached for the whole run — no sync, no RC
 * binding, free tier until the next cold start (#1735).
 */

const authInitialize = vi.fn<() => Promise<AuthSession | null>>()
const addListener = vi.fn<(...a: unknown[]) => Promise<{ remove: () => void }>>()
const listeners = new Set<(s: AuthSession | null) => void>()

function onSessionChange(listener: (s: AuthSession | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What the adapter's `setSession` does to everyone subscribed. */
function emitSession(s: AuthSession | null): void {
  for (const l of [...listeners]) l(s)
}

const ANON: AuthSession = {
  userId: "anon-1",
  email: null,
  name: null,
  picture: null,
  anonymous: true,
  accessTokenExpiresAt: Date.now() + 3_600_000,
  tier: "free",
  tierExpiresAt: null,
  quotaId: "q1",
}

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    auth: {
      initialize: () => authInitialize(),
      onSessionChange,
      fetchMe: vi.fn(),
      refreshTokens: vi.fn(),
      getSession: () => null,
    },
  }),
}))

vi.mock("@lectorium/stores/useChatStore.js", () => ({
  useChatStore: () => ({ resetComposeLock: vi.fn() }),
}))

vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ logOut: vi.fn() }),
}))

vi.mock("@lectorium/services/monitoring/index.js", () => ({
  setMonitoringUser: vi.fn(),
  setMonitoringTag: vi.fn(),
}))

vi.mock("@lectorium/services/dataWipe.js", () => ({ wipeLocalUserData: vi.fn() }))

vi.mock("@capacitor/app", () => ({
  App: { addListener: (...a: unknown[]) => addListener(...a) },
}))

import { useAuthStore } from "../useAuthStore.js"

describe("useAuthStore.restore — a failed bootstrap must not detach the store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listeners.clear()
    authInitialize.mockReset().mockResolvedValue(ANON)
    addListener.mockReset().mockResolvedValue({ remove: vi.fn() })
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => vi.restoreAllMocks())

  it("applies a session that arrives after initialize() rejected", async () => {
    authInitialize.mockRejectedValue(new Error("offline"))
    const store = useAuthStore()

    await store.restore()
    expect(store.status).toBe("error")
    expect(store.userId).toBeNull()

    // Network came back: the adapter re-minted the anonymous identity from
    // getAccessToken() and pushed it through the port.
    emitSession(ANON)

    expect(store.userId).toBe("anon-1")
    expect(store.status).toBe("anonymous")
  })

  it("registers the resume listener even when the bootstrap fails", async () => {
    authInitialize.mockRejectedValue(new Error("offline"))

    await useAuthStore().restore()

    // Same shape as the subscription: skipping it costs the whole run's
    // foreground tier syncs.
    expect(addListener).toHaveBeenCalledWith("appStateChange", expect.any(Function))
  })

  it("still bootstraps and applies the session on the happy path", async () => {
    const store = useAuthStore()

    await store.restore()

    expect(store.userId).toBe("anon-1")
    expect(store.status).toBe("anonymous")
    expect(listeners.size).toBe(1)
  })

  it("keeps exactly one subscription across repeated restores", async () => {
    const store = useAuthStore()

    await store.restore()
    await store.restore()
    await store.restore()

    expect(listeners.size).toBe(1)
    // And one resume listener, not three.
    expect(addListener).toHaveBeenCalledOnce()
  })

  it("survives a listener registration that rejects", async () => {
    addListener.mockRejectedValue(new Error("no plugin"))
    const store = useAuthStore()

    await store.restore()

    expect(store.userId).toBe("anon-1")
  })
})

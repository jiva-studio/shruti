import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import { SERVERS } from "@lib/domain/servers.js"

const portSignOut = vi.fn().mockResolvedValue(undefined)
const portInitialize = vi.fn().mockResolvedValue(null)
const portOnSessionChange = vi.fn().mockReturnValue(() => undefined)
const preferencesSet = vi.fn().mockResolvedValue(undefined)
const setActiveServer = vi.fn()
const activeServer = ref(SERVERS[0])

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    auth: {
      signOut: portSignOut,
      initialize: portInitialize,
      onSessionChange: portOnSessionChange,
      fetchMe: vi.fn(),
      refreshTokens: vi.fn(),
    },
    activeServer,
    setActiveServer: (server: (typeof SERVERS)[number]) => {
      setActiveServer(server)
      activeServer.value = server
    },
    preferences: {
      set: preferencesSet,
      get: vi.fn().mockResolvedValue(null),
      remove: vi.fn(),
    },
  }),
}))

vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}))

import { useAuthStore } from "../useAuthStore.js"

describe("useAuthStore.switchAnonymousRegion", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    activeServer.value = SERVERS.find((s) => s.id === "global")!
    portSignOut.mockReset().mockResolvedValue(undefined)
    portInitialize.mockReset().mockResolvedValue(null)
    preferencesSet.mockReset().mockResolvedValue(undefined)
    setActiveServer.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("signs out, flips activeServer + persists, THEN re-bootstraps anonymous", async () => {
    const calls: string[] = []
    portSignOut.mockImplementation(async () => {
      calls.push(`signOut@${activeServer.value.id}`)
    })
    setActiveServer.mockImplementation((server) => {
      calls.push(`setActiveServer@${server.id}`)
    })
    preferencesSet.mockImplementation(async (_k, v) => {
      calls.push(`preferences.set@${v}`)
    })
    portInitialize.mockImplementation(async () => {
      calls.push(`initialize@${activeServer.value.id}`)
      return null
    })

    const store = useAuthStore()
    await store.switchAnonymousRegion("russia")

    // (1) port.signOut runs against the SOURCE region
    expect(calls[0]).toBe("signOut@global")
    // (2) activeServer flips to the destination BEFORE the persist write
    //     (promotePreferredServer order: setActiveServer → preferences.set)
    expect(calls[1]).toBe("setActiveServer@russia")
    expect(calls[2]).toBe("preferences.set@russia")
    // (3) port.initialize (which mints /auth/anonymous) sees the
    //     destination region in cfg.baseUrl()
    expect(calls[3]).toBe("initialize@russia")
  })

  it("rejects an unknown region id without touching auth state", async () => {
    const store = useAuthStore()
    await expect(store.switchAnonymousRegion("atlantis")).rejects.toThrow(/Unknown server id/)
    expect(portSignOut).not.toHaveBeenCalled()
    expect(setActiveServer).not.toHaveBeenCalled()
    expect(portInitialize).not.toHaveBeenCalled()
  })

  it("is resilient to preferences.set failure — still mints anonymous on the new region", async () => {
    preferencesSet.mockRejectedValueOnce(new Error("disk full"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const store = useAuthStore()
    await store.switchAnonymousRegion("russia")
    expect(activeServer.value.id).toBe("russia")
    expect(portInitialize).toHaveBeenCalled()
    warn.mockRestore()
  })
})

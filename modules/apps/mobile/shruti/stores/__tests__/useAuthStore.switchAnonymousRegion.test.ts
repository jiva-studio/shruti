import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import { SERVERS } from "@lib/domain/servers.js"

const portSignOut = vi.fn().mockResolvedValue(undefined)
const portInitialize = vi.fn().mockResolvedValue(null)
const portOnSessionChange = vi.fn().mockReturnValue(() => undefined)
const setActiveServerById = vi.fn()
const activeServer = ref(SERVERS[0])

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    auth: {
      signOut: portSignOut,
      initialize: portInitialize,
      onSessionChange: portOnSessionChange,
      fetchMe: vi.fn(),
      refreshTokens: vi.fn(),
    },
    activeServer,
    setActiveServerById: (id: string) => {
      const target = SERVERS.find((s) => s.id === id)
      if (!target) throw new Error(`Unknown server id: ${id}`)
      setActiveServerById(id)
      activeServer.value = target
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
    setActiveServerById.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("signs out on the SOURCE region, flips activeServer, THEN re-bootstraps on DEST", async () => {
    const calls: string[] = []
    portSignOut.mockImplementation(async () => {
      calls.push(`signOut@${activeServer.value.id}`)
    })
    setActiveServerById.mockImplementation((id: string) => {
      calls.push(`setActiveServerById@${id}`)
    })
    portInitialize.mockImplementation(async () => {
      calls.push(`initialize@${activeServer.value.id}`)
      return null
    })

    const store = useAuthStore()
    await store.switchAnonymousRegion("russia")

    // (1) port.signOut hits the SOURCE region while activeServer is still global
    expect(calls[0]).toBe("signOut@global")
    // (2) activeServer flips to the destination via setActiveServerById
    expect(calls[1]).toBe("setActiveServerById@russia")
    // (3) port.initialize (which POSTs /auth/anonymous) sees the destination
    //     region in cfg.baseUrl(). The preferredServerId persist is the
    //     activeServer watcher's job inside initShruti, out of scope here.
    expect(calls[2]).toBe("initialize@russia")
  })

  it("rejects an unknown region id without touching auth state", async () => {
    const store = useAuthStore()
    await expect(store.switchAnonymousRegion("atlantis")).rejects.toThrow(/Unknown server id/)
    expect(portSignOut).not.toHaveBeenCalled()
    expect(setActiveServerById).not.toHaveBeenCalled()
    expect(portInitialize).not.toHaveBeenCalled()
  })
})

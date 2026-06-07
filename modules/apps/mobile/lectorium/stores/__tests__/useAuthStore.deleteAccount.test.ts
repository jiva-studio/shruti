import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { AccountDeleteError } from "@ports/app/auth.js"

const wipeLocalUserData = vi.fn().mockResolvedValue(undefined)
const purchasesLogOut = vi.fn().mockResolvedValue(undefined)
const authDeleteAccount = vi.fn().mockResolvedValue(undefined)
const authInitialize = vi.fn().mockResolvedValue(null)
const authOnSessionChange = vi.fn().mockReturnValue(() => undefined)

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    auth: {
      deleteAccount: authDeleteAccount,
      initialize: authInitialize,
      onSessionChange: authOnSessionChange,
      fetchMe: vi.fn(),
      refreshTokens: vi.fn(),
    },
    repositories: vi.fn(),
    filesStorage: { clearAll: vi.fn() },
    preferences: { remove: vi.fn() },
  }),
}))

vi.mock("@lectorium/services/dataWipe.js", () => ({
  wipeLocalUserData: (...args: unknown[]) => wipeLocalUserData(...args),
}))

vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ logOut: purchasesLogOut }),
}))

vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}))

import { useAuthStore } from "../useAuthStore.js"

describe("useAuthStore.deleteAccount", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    wipeLocalUserData.mockReset().mockResolvedValue(undefined)
    purchasesLogOut.mockReset().mockResolvedValue(undefined)
    authDeleteAccount.mockReset().mockResolvedValue(undefined)
    authInitialize.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("happy path runs server delete, wipe, RC logOut, and re-bootstraps", async () => {
    const store = useAuthStore()
    await store.deleteAccount({ wipeLocal: true })
    expect(authDeleteAccount).toHaveBeenCalledOnce()
    expect(wipeLocalUserData).toHaveBeenCalledOnce()
    expect(purchasesLogOut).toHaveBeenCalledOnce()
    expect(authInitialize).toHaveBeenCalled() // restore() ran
  })

  it("wipe failure does not block RC logOut or anonymous re-bootstrap", async () => {
    wipeLocalUserData.mockRejectedValueOnce(new Error("disk gone"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const store = useAuthStore()
    await store.deleteAccount({ wipeLocal: true })
    expect(purchasesLogOut).toHaveBeenCalledOnce()
    expect(authInitialize).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it("410 already-deleted is treated as success and falls through to cleanup", async () => {
    authDeleteAccount.mockRejectedValueOnce(new AccountDeleteError("already-deleted", 410))
    const store = useAuthStore()
    await store.deleteAccount({ wipeLocal: true })
    expect(wipeLocalUserData).toHaveBeenCalledOnce()
    expect(purchasesLogOut).toHaveBeenCalledOnce()
    expect(authInitialize).toHaveBeenCalled()
  })

  it("non-410 error rethrows and skips local cleanup", async () => {
    authDeleteAccount.mockRejectedValueOnce(new AccountDeleteError("server", 503))
    const store = useAuthStore()
    await expect(store.deleteAccount({ wipeLocal: true })).rejects.toBeInstanceOf(
      AccountDeleteError
    )
    expect(wipeLocalUserData).not.toHaveBeenCalled()
    expect(purchasesLogOut).not.toHaveBeenCalled()
    expect(authInitialize).not.toHaveBeenCalled()
  })

  it("wipeLocal=false skips wipe but still runs RC logOut and re-bootstrap", async () => {
    const store = useAuthStore()
    await store.deleteAccount({ wipeLocal: false })
    expect(wipeLocalUserData).not.toHaveBeenCalled()
    expect(purchasesLogOut).toHaveBeenCalledOnce()
    expect(authInitialize).toHaveBeenCalled()
  })
})

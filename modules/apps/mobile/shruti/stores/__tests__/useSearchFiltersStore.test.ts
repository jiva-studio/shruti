import { describe, it, expect, vi, beforeEach } from "vitest"
import { setActivePinia, createPinia } from "pinia"

const toastError = vi.fn()
const prefSet = vi.fn()

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, show: vi.fn(), success: vi.fn() }),
}))
vi.mock("@shruti/i18n/index.js", () => ({
  detectDeviceLocaleAsync: () => Promise.resolve("en"),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    preferences: { set: prefSet, get: () => Promise.resolve(null), remove: vi.fn() },
    repositories: () => ({ languages: { listWithTracks: () => Promise.resolve([]) } }),
  }),
}))

import { useSearchFiltersStore } from "../useSearchFiltersStore.js"

describe("useSearchFiltersStore — persist failure", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    toastError.mockClear()
    prefSet.mockReset()
  })

  it("toasts filtersNotSaved when persisting a filter change fails", async () => {
    prefSet.mockRejectedValue(new Error("disk full"))
    const store = useSearchFiltersStore()

    // The setter applies the value in memory and tries to persist; the failed
    // write must surface the (previously unused) errors.filtersNotSaved string
    // rather than reject unhandled out of the setter.
    await store.setLanguages(["en"])

    expect(prefSet).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledWith("errors.filtersNotSaved")
    // The in-memory selection is still applied.
    expect(store.languageCodes).toEqual(["en"])
  })

  it("does not toast when persistence succeeds", async () => {
    prefSet.mockResolvedValue(undefined)
    const store = useSearchFiltersStore()

    await store.setLanguages(["en"])

    expect(prefSet).toHaveBeenCalledOnce()
    expect(toastError).not.toHaveBeenCalled()
  })
})

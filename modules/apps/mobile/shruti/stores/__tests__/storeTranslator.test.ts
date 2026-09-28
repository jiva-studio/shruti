import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import en from "@shruti/i18n/locales/en/errors.js"

/**
 * A store is created by whoever touches it first — a service, the sync engine,
 * a notification handler — often outside any component's setup(). It
 * translates through the app's global i18n instance, never `useI18n()`, which
 * needs a component to bind to. vue-i18n is NOT mocked here.
 */

const toastError = vi.fn()

vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, show: vi.fn(), success: vi.fn() }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    preferences: {
      get: async () => null,
      set: async () => {
        throw new Error("disk full")
      },
      remove: async () => {},
    },
    repositories: () => ({ languages: { listWithTracks: async () => [] } }),
  }),
}))

import { useSearchFiltersStore } from "../useSearchFiltersStore.js"

describe("store translator", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    toastError.mockClear()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("creates a store outside any component and translates its messages", async () => {
    const filters = useSearchFiltersStore()

    await filters.setAuthors(["a1"])

    expect(toastError).toHaveBeenCalledWith(en.filtersNotSaved)
  })
})

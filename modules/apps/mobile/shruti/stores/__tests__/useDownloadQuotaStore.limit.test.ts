import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const GIB = 1024 * 1024 * 1024
const stored = new Map<string, string>()

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    preferences: {
      get: async (key: string) => stored.get(key) ?? null,
      set: async (key: string, value: string) => {
        stored.set(key, value)
      },
      remove: async (key: string) => {
        stored.delete(key)
      },
    },
  }),
}))

/** A fresh store over a fresh config cache, so each test hydrates from `stored`. */
async function freshStore() {
  vi.resetModules()
  const { useDownloadQuotaStore } = await import("../useDownloadQuotaStore.js")
  setActivePinia(createPinia())
  const store = useDownloadQuotaStore()
  // Let the config ref hydrate from storage.
  await new Promise((r) => setTimeout(r, 0))
  return store
}

describe("useDownloadQuotaStore offline budget", () => {
  beforeEach(() => {
    stored.clear()
  })

  it("defaults to 8 GiB when the user never chose a budget", async () => {
    const store = await freshStore()

    expect(store.limitBytes).toBe(8 * GIB)
  })

  it("reads the budget installed apps stored under settings.downloadLimitBytes", async () => {
    stored.set("settings.downloadLimitBytes", JSON.stringify(2 * GIB))

    const store = await freshStore()

    expect(store.limitBytes).toBe(2 * GIB)
  })
})

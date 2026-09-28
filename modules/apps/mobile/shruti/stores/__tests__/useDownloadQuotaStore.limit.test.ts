import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"

const GIB = 1024 * 1024 * 1024
/** Stored preferences, JSON-encoded as useConfig writes them. */
const stored = new Map<string, string>()

vi.mock("@shruti/shruti.js", () => ({ useShruti: () => ({}) }))
vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: <T>(key: string, initial: T) =>
    ref(stored.has(key) ? (JSON.parse(stored.get(key)!) as T) : initial),
}))

import { useDownloadQuotaStore } from "../useDownloadQuotaStore.js"

describe("useDownloadQuotaStore offline budget", () => {
  beforeEach(() => {
    stored.clear()
    setActivePinia(createPinia())
  })

  it("defaults to 8 GiB when the user never chose a budget", () => {
    expect(useDownloadQuotaStore().limitBytes).toBe(8 * GIB)
  })

  it("reads the budget installed apps stored under settings.downloadLimitBytes", () => {
    stored.set("settings.downloadLimitBytes", JSON.stringify(2 * GIB))

    expect(useDownloadQuotaStore().limitBytes).toBe(2 * GIB)
  })
})

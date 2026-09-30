import { afterEach, describe, expect, it, vi } from "vitest"
import { readMarker } from "../readMarker.js"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("readMarker", () => {
  it("answers the stored value", async () => {
    const markers = { get: async () => "42", set: async () => {}, remove: async () => {} }

    expect(await readMarker(markers, "sync.key")).toBe("42")
  })

  it("logs a marker it cannot read and answers null", async () => {
    const boom = new Error("preferences unavailable")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const markers = {
      get: () => Promise.reject(boom),
      set: async () => {},
      remove: async () => {},
    }

    expect(await readMarker(markers, "sync.key")).toBeNull()
    expect(warn).toHaveBeenCalledWith("[sync] marker read failed", "sync.key", boom)
  })
})

import { beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { useShareJobStore } from "../useShareJobStore.js"

describe("useShareJobStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("starts empty (slot is free)", () => {
    const store = useShareJobStore()
    expect(store.isRunning).toBe(false)
    expect(store.job).toBe(null)
  })

  it("tryStart claims the slot and reports the job kind/noteId", () => {
    const store = useShareJobStore()
    const ok = store.tryStart("video", "note-1")
    expect(ok).toBe(true)
    expect(store.isRunning).toBe(true)
    expect(store.job).toMatchObject({ kind: "video", noteId: "note-1" })
    expect(typeof store.job?.startedAt).toBe("number")
  })

  it("tryStart returns false when the slot is already occupied (concurrent share blocked)", () => {
    const store = useShareJobStore()
    expect(store.tryStart("audio", "note-A")).toBe(true)
    expect(store.tryStart("video", "note-B")).toBe(false)
    // Slot still belongs to the first claimant.
    expect(store.job).toMatchObject({ kind: "audio", noteId: "note-A" })
  })

  it("tryStart returns false even on the same noteId/kind (no special-casing)", () => {
    const store = useShareJobStore()
    expect(store.tryStart("video", "note-X")).toBe(true)
    expect(store.tryStart("video", "note-X")).toBe(false)
  })

  it("finish releases the slot for a subsequent tryStart", () => {
    const store = useShareJobStore()
    store.tryStart("video", "note-1")
    store.finish()
    expect(store.isRunning).toBe(false)
    expect(store.job).toBe(null)
    expect(store.tryStart("audio", "note-2")).toBe(true)
  })

  it("finish on an empty store is a safe no-op", () => {
    const store = useShareJobStore()
    expect(() => store.finish()).not.toThrow()
    expect(store.isRunning).toBe(false)
  })
})

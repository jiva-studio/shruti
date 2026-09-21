import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { usePlaylistProgressMap } from "../usePlaylistProgressMap.js"

const A = "i-1" as PlaylistItemId
const B = "i-2" as PlaylistItemId
const CATALOG_MS = 600_000

function make(catalog: (id: PlaylistItemId) => number = () => CATALOG_MS) {
  return usePlaylistProgressMap(catalog)
}

describe("usePlaylistProgressMap", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"))
  })

  it("reads 0 / null for an item it has never seen", () => {
    const m = make()

    expect(m.progressMsOf(A)).toBe(0)
    expect(m.completedAtOf(A)).toBeNull()
  })

  it("replaceAll swaps both maps wholesale", () => {
    const m = make()

    m.replaceAll(new Map([[A, 1000]]), new Map([[A, 42]]))
    expect(m.progressMsOf(A)).toBe(1000)
    expect(m.completedAtOf(A)).toBe(42)

    m.replaceAll(new Map([[B, 2000]]), new Map())
    expect(m.progressMsOf(A)).toBe(0)
    expect(m.completedAtOf(A)).toBeNull()
    expect(m.progressMsOf(B)).toBe(2000)
  })

  it("clear empties both maps", () => {
    const m = make()
    m.replaceAll(new Map([[A, 1000]]), new Map([[A, 42]]))

    m.clear()

    expect(m.progressMap.value.size).toBe(0)
    expect(m.completedAtMap.value.size).toBe(0)
  })

  it("patch records the position and leaves an unfinished item uncompleted", () => {
    const m = make()

    m.patch(A, 120_000)

    expect(m.progressMsOf(A)).toBe(120_000)
    expect(m.completedAtOf(A)).toBeNull()
  })

  it("patch marks the item completed once it reaches the catalog duration", () => {
    const m = make()

    m.patch(A, CATALOG_MS)

    expect(m.completedAtOf(A)).toBe(Date.now())
  })

  it("prefers the engine duration when it is shorter than the catalog's", () => {
    const m = make()

    m.patch(A, 300_000, 300_000)

    expect(m.completedAtOf(A)).toBe(Date.now())
  })

  it("completes from the engine duration alone for an item outside the loaded page", () => {
    const m = make(() => 0)

    m.patch(A, 300_000, 300_000)

    expect(m.completedAtOf(A)).toBe(Date.now())
  })

  it("never completes when neither duration is known", () => {
    const m = make(() => 0)

    m.patch(A, 300_000)

    expect(m.progressMsOf(A)).toBe(300_000)
    expect(m.completedAtOf(A)).toBeNull()
  })

  it("allowCompletion:false records the position without archiving the lecture", () => {
    const m = make()

    m.patch(A, CATALOG_MS, undefined, { allowCompletion: false })

    expect(m.progressMsOf(A)).toBe(CATALOG_MS)
    expect(m.completedAtOf(A)).toBeNull()
  })

  it("keeps a completed item's high-water mark when the engine settles short of the end", () => {
    const m = make()
    m.patch(A, CATALOG_MS)
    const completedAt = m.completedAtOf(A)

    m.patch(A, CATALOG_MS - 800)

    expect(m.progressMsOf(A)).toBe(CATALOG_MS)
    expect(m.completedAtOf(A)).toBe(completedAt)
  })

  it("lets an in-progress item's position move backwards on a rewind", () => {
    const m = make()
    m.patch(A, 120_000)

    m.patch(A, 30_000)

    expect(m.progressMsOf(A)).toBe(30_000)
  })

  it("does not restamp an item that was already completed", () => {
    const m = make()
    m.replaceAll(new Map(), new Map([[A, 111]]))

    m.patch(A, CATALOG_MS)

    expect(m.completedAtOf(A)).toBe(111)
  })

  it("leaves other items untouched when one is patched", () => {
    const m = make()
    m.replaceAll(new Map([[B, 5000]]), new Map([[B, 7]]))

    m.patch(A, 1000)

    expect(m.progressMsOf(B)).toBe(5000)
    expect(m.completedAtOf(B)).toBe(7)
  })
})

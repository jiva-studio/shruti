import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { COMPLETION_THRESHOLD_MS } from "@lib/domain/listeningSession.js"

interface Row {
  id: string
  itemId: string
  from: number
  to: number | null
}

let rows: Row[] = []
let failNextFinish = false

const repo = {
  start: vi.fn(async ({ itemId, position }: { itemId: string; position: number }) => {
    const id = `s-${rows.length + 1}`
    rows.push({ id, itemId, from: position, to: null })
    return id
  }),
  forceStart: vi.fn(async ({ itemId, position }: { itemId: string; position: number }) => {
    const id = `s-${rows.length + 1}`
    rows.push({ id, itemId, from: position, to: null })
    return id
  }),
  tick: vi.fn(async (id: string, { position }: { position: number }) => {
    const row = rows.find((r) => r.id === id)
    if (row) row.to = position
  }),
  finish: vi.fn(async (id: string, { position }: { position: number }) => {
    if (failNextFinish) {
      failNextFinish = false
      throw new Error("db locked")
    }
    const row = rows.find((r) => r.id === id)
    if (row) row.to = position
  }),
}

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ repositories: () => ({ listeningSessions: repo }) }),
}))

const reported: unknown[] = []
vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: (_scope: string, e: unknown) => void reported.push(e),
}))

import { usePlayerSession } from "../usePlayerSession.js"

const ITEM = "pi-1" as PlaylistItemId
const OTHER = "pi-2" as PlaylistItemId
const DURATION = 600_000

function harness(itemId: PlaylistItemId | null = ITEM) {
  const itemIdRef = ref<PlaylistItemId | null>(itemId)
  const playingRef = ref(false)
  const positionMsRef = ref(0)
  const patched: [string, number][] = []
  const session = usePlayerSession({
    itemIdRef,
    playingRef,
    positionMsRef,
    patchPlaylistProgress: (id, ms) => void patched.push([id, ms]),
  })
  return { session, itemIdRef, playingRef, positionMsRef, patched }
}

/** Lets the tracker's serialized write queue drain. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe("usePlayerSession", () => {
  beforeEach(() => {
    rows = []
    reported.length = 0
    failNextFinish = false
  })

  it("opens a session on the first playing progress event and ticks the same row after", async () => {
    const h = harness()
    h.playingRef.value = true

    h.session.applyStatus(10_000, DURATION)
    await settle()
    expect(rows).toEqual([{ id: "s-1", itemId: ITEM, from: 10, to: null }])
    expect(h.session.hasActive()).toBe(true)
    expect(h.session.activeItemId()).toBe(ITEM)

    h.session.applyStatus(25_000, DURATION)
    await settle()
    expect(rows).toHaveLength(1)
  })

  it("closes the previous item's session when the playing item changes", async () => {
    const h = harness()
    h.playingRef.value = true
    h.session.applyStatus(10_000, DURATION)
    await settle()

    h.itemIdRef.value = OTHER
    h.session.applyStatus(0, DURATION)
    await settle()

    expect(rows.map((r) => [r.itemId, r.from, r.to])).toEqual([
      [ITEM, 10, 0],
      [OTHER, 0, null],
    ])
    expect(h.session.activeItemId()).toBe(OTHER)
  })

  it("closes the session and patches the playlist when playback pauses", async () => {
    const h = harness()
    h.playingRef.value = true
    h.session.applyStatus(10_000, DURATION)
    await settle()

    h.playingRef.value = false
    h.session.applyStatus(42_000, DURATION)
    await settle()

    expect(rows[0].to).toBe(42)
    expect(h.patched).toEqual([[ITEM, 42_000]])
    expect(h.session.hasActive()).toBe(false)
  })

  it("does nothing at all when no item is open", async () => {
    const h = harness(null)
    h.playingRef.value = true

    h.session.applyStatus(10_000, DURATION)
    h.session.flushOnHide()
    await settle()

    expect(rows).toEqual([])
    expect(h.patched).toEqual([])
  })

  it("finishes at the full duration when the track reaches the end", async () => {
    const h = harness()
    h.playingRef.value = true
    h.session.applyStatus(10_000, DURATION)
    await settle()

    h.session.applyStatus(DURATION - (COMPLETION_THRESHOLD_MS - 500), DURATION)
    await settle()

    expect(rows[0].to).toBe(DURATION / 1000)
    expect(h.patched).toEqual([[ITEM, DURATION]])
  })

  it("still patches the playlist at the end when no session was ever open", async () => {
    const h = harness()

    h.session.applyStatus(DURATION, DURATION)
    await settle()

    expect(rows).toEqual([])
    expect(h.patched).toEqual([[ITEM, DURATION]])
  })

  it("flushes the open session at the current position when the app hides", async () => {
    const h = harness()
    h.playingRef.value = true
    h.session.applyStatus(10_000, DURATION)
    await settle()

    h.positionMsRef.value = 90_000
    h.session.flushOnHide()
    await settle()

    expect(rows[0].to).toBe(90)
    expect(h.patched).toEqual([[ITEM, 90_000]])
  })

  it("skips the flush when nothing is open", async () => {
    const h = harness()
    h.positionMsRef.value = 90_000

    h.session.flushOnHide()
    await settle()

    expect(h.patched).toEqual([])
  })

  it("patches the playlist on finishCurrent even with no open session", async () => {
    const h = harness()

    await h.session.finishCurrent(ITEM, 123_000)

    expect(rows).toEqual([])
    expect(h.patched).toEqual([[ITEM, 123_000]])
  })

  it("closes the open session on finishCurrent", async () => {
    const h = harness()
    h.playingRef.value = true
    h.session.applyStatus(10_000, DURATION)
    await settle()

    await h.session.finishCurrent(ITEM, 123_000)

    expect(rows[0].to).toBe(123)
    expect(h.patched).toEqual([[ITEM, 123_000]])
    expect(h.session.hasActive()).toBe(false)
  })

  it("splits a seek into a closed row at the old position and a new row at the new one", async () => {
    const h = harness()
    h.playingRef.value = true
    h.session.applyStatus(10_000, DURATION)
    await settle()

    await h.session.recordSeek({
      itemId: ITEM,
      positionBeforeMs: 30_000,
      positionAfterMs: 300_000,
      willKeepPlaying: true,
    })

    expect(rows.map((r) => [r.from, r.to])).toEqual([
      [10, 30],
      [300, null],
    ])
    expect(h.patched).toEqual([[ITEM, 300_000]])
  })

  it("leaves no session open after a seek that does not resume playback", async () => {
    const h = harness()
    h.playingRef.value = true
    h.session.applyStatus(10_000, DURATION)
    await settle()

    await h.session.recordSeek({
      itemId: ITEM,
      positionBeforeMs: 30_000,
      positionAfterMs: 300_000,
      willKeepPlaying: false,
    })

    expect(rows.map((r) => [r.from, r.to])).toEqual([[10, 30]])
    expect(h.session.hasActive()).toBe(false)
    expect(h.patched).toEqual([[ITEM, 300_000]])
  })

  it("routes a failed journal write to monitoring instead of rejecting unhandled", async () => {
    const h = harness()
    h.playingRef.value = true
    h.session.applyStatus(10_000, DURATION)
    await settle()

    failNextFinish = true
    h.playingRef.value = false
    h.session.applyStatus(42_000, DURATION)
    await settle()

    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe("db locked")
    expect(h.patched).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { ListeningSessionId } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import { useListeningSessionTracker } from "../useListeningSessionTracker.js"

const ITEM = "item_1" as PlaylistItemId
const OTHER = "item_2" as PlaylistItemId
const NOON = new Date(2026, 5, 1, 12, 0, 0, 0).getTime()

type Row = {
  id: string
  itemId: PlaylistItemId
  from: number
  to: number | null
  forced: boolean
  endedAtSec?: number
}

interface FakeRepo extends IListeningSessionRepository {
  rows: Row[]
  open(): Row[]
  failNext: { start?: boolean; finish?: boolean }
}

function fakeRepo(): FakeRepo {
  const rows: Row[] = []
  let n = 0
  const failNext: { start?: boolean; finish?: boolean } = {}
  const byId = (id: ListeningSessionId) => rows.find((r) => r.id === id)
  const open = (itemId: PlaylistItemId, position: number, forced: boolean): ListeningSessionId => {
    if (failNext.start) {
      failNext.start = false
      throw new Error("db locked")
    }
    const id = `s${++n}`
    rows.push({ id, itemId, from: position, to: null, forced })
    return id as ListeningSessionId
  }
  return {
    rows,
    failNext,
    open: () => rows.filter((r) => r.to === null),
    async start({ itemId, position }: { itemId: PlaylistItemId; position: number }) {
      return open(itemId, position, false)
    },
    async forceStart({ itemId, position }: { itemId: PlaylistItemId; position: number }) {
      return open(itemId, position, true)
    },
    async tick(id: ListeningSessionId, { position }: { position: number }) {
      const row = byId(id)
      if (row) row.to = position
    },
    async finish(id: ListeningSessionId, { position }: { position: number }) {
      if (failNext.finish) {
        failNext.finish = false
        throw new Error("db locked")
      }
      const row = byId(id)
      if (row) row.to = position
    },
    async finishAt(
      id: ListeningSessionId,
      { position, endedAtSec }: { position: number; endedAtSec: number }
    ) {
      const row = byId(id)
      if (row) {
        row.to = position
        row.endedAtSec = endedAtSec
      }
    },
  } as unknown as FakeRepo
}

function trackerWith(repo: FakeRepo) {
  return useListeningSessionTracker({ getRepo: () => repo })
}

describe("useListeningSessionTracker — one row per stretch of listening", () => {
  let repo: FakeRepo

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    repo = fakeRepo()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens one row and closes it where playback stopped", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 10_000 })
    expect(tracker.hasActiveSession()).toBe(true)
    expect(tracker.activeItemId()).toBe(ITEM)

    await tracker.finish({ positionMs: 95_000 })
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0]).toMatchObject({ from: 10, to: 95, forced: false })
    expect(tracker.hasActiveSession()).toBe(false)
  })

  it("opens a single row for a burst of progress events on the same item", async () => {
    const tracker = trackerWith(repo)
    await Promise.all([
      tracker.start({ itemId: ITEM, positionMs: 1_000 }),
      tracker.start({ itemId: ITEM, positionMs: 1_500 }),
      tracker.start({ itemId: ITEM, positionMs: 2_000 }),
    ])
    expect(repo.rows).toHaveLength(1)
  })

  it("closes the lingering row when playback moves to another lecture", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })
    await tracker.start({ itemId: OTHER, positionMs: 5_000 })

    expect(repo.rows).toHaveLength(2)
    expect(repo.rows[0]).toMatchObject({ itemId: ITEM, to: 5 })
    expect(repo.open()).toHaveLength(1)
    expect(tracker.activeItemId()).toBe(OTHER)
  })

  it("closing twice leaves one closed row, not a second open one", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })
    await tracker.finish({ positionMs: 60_000 })
    await tracker.finish({ positionMs: 70_000 })

    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0].to).toBe(60)
  })

  it("does nothing when told to close with nothing playing", async () => {
    const tracker = trackerWith(repo)
    await tracker.flushOnHide({ positionMs: 1_000 })
    expect(repo.rows).toEqual([])
  })

  it("keeps a replay from being swallowed by the close it follows", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })
    const closing = tracker.finish({ positionMs: 60_000 })
    const replay = tracker.start({ itemId: ITEM, positionMs: 0 })
    await Promise.all([closing, replay])

    expect(repo.rows).toHaveLength(2)
    expect(repo.rows[0].to).toBe(60)
    expect(repo.open()).toHaveLength(1)
  })
})

describe("useListeningSessionTracker — ticks", () => {
  let repo: FakeRepo

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    repo = fakeRepo()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("writes a tick at most once every 15 s", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })

    await tracker.tick({ positionMs: 5_000 })
    expect(repo.rows[0].to).toBeNull()

    vi.setSystemTime(NOON + 14_999)
    await tracker.tick({ positionMs: 14_000 })
    expect(repo.rows[0].to).toBeNull()

    vi.setSystemTime(NOON + 15_000)
    await tracker.tick({ positionMs: 15_000 })
    expect(repo.rows[0].to).toBe(15)
  })

  it("ignores a tick when nothing is playing", async () => {
    const tracker = trackerWith(repo)
    await tracker.tick({ positionMs: 5_000 })
    expect(repo.rows).toEqual([])
  })
})

describe("useListeningSessionTracker — seeking", () => {
  let repo: FakeRepo

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    repo = fakeRepo()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("ends the stretch where the user jumped from and starts a new one where they landed", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })
    await tracker.seek({
      itemId: ITEM,
      positionBeforeMs: 30_000,
      positionAfterMs: 600_000,
      willKeepPlaying: true,
    })

    expect(repo.rows).toHaveLength(2)
    expect(repo.rows[0]).toMatchObject({ from: 0, to: 30 })
    // Pinned to where the user landed — never inheriting the high-water mark,
    // which would credit the skipped-over stretch as listened.
    expect(repo.rows[1]).toMatchObject({ from: 600, to: null, forced: true })
  })

  it("leaves nothing open when the user seeks while paused", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })
    await tracker.seek({
      itemId: ITEM,
      positionBeforeMs: 30_000,
      positionAfterMs: 600_000,
      willKeepPlaying: false,
    })

    expect(repo.open()).toEqual([])
    expect(tracker.hasActiveSession()).toBe(false)
  })

  it("opens a stretch when the user seeks into a lecture that was not playing", async () => {
    const tracker = trackerWith(repo)
    await tracker.seek({
      itemId: ITEM,
      positionBeforeMs: 0,
      positionAfterMs: 120_000,
      willKeepPlaying: true,
    })

    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0]).toMatchObject({ from: 120, to: null })
  })
})

describe("useListeningSessionTracker — crossing local midnight", () => {
  let repo: FakeRepo

  beforeEach(() => {
    vi.useFakeTimers()
    repo = fakeRepo()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("credits each day its own row instead of the whole stretch to the last one", async () => {
    // Playback starts at 23:50 and is still running at 00:20 the next day.
    const start = new Date(2026, 5, 1, 23, 50, 0, 0).getTime()
    vi.setSystemTime(start)
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })

    vi.setSystemTime(new Date(2026, 5, 2, 0, 20, 0, 0).getTime())
    await tracker.finish({ positionMs: 30 * 60_000 })

    expect(repo.rows).toHaveLength(2)
    // Ten minutes of audio belong to the first day, ending a second before
    // midnight; the rest to the second.
    const midnightSec = Math.floor(new Date(2026, 5, 2, 0, 0, 0, 0).getTime() / 1000)
    expect(repo.rows[0]).toMatchObject({ from: 0, to: 600, endedAtSec: midnightSec - 1 })
    expect(repo.rows[1]).toMatchObject({ from: 600, to: 1800 })
  })

  it("gives a stretch spanning two midnights a row for each day", async () => {
    const start = new Date(2026, 5, 1, 23, 0, 0, 0).getTime()
    vi.setSystemTime(start)
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })

    vi.setSystemTime(new Date(2026, 5, 3, 1, 0, 0, 0).getTime())
    await tracker.finish({ positionMs: 26 * 3_600_000 })

    expect(repo.rows).toHaveLength(3)
    expect(repo.rows.map((r) => r.to)).toEqual([3600, 90_000, 93_600])
  })

  it("leaves a stretch inside one day as a single row", async () => {
    vi.setSystemTime(NOON)
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })
    vi.setSystemTime(NOON + 60 * 60_000)
    await tracker.finish({ positionMs: 60 * 60_000 })

    expect(repo.rows).toHaveLength(1)
  })
})

describe("useListeningSessionTracker — when the database refuses", () => {
  let repo: FakeRepo

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    repo = fakeRepo()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("lets a retry through after a failed open instead of deduping it away", async () => {
    const tracker = trackerWith(repo)
    repo.failNext.start = true
    await expect(tracker.start({ itemId: ITEM, positionMs: 0 })).rejects.toThrow("db locked")
    expect(tracker.hasActiveSession()).toBe(false)

    await tracker.start({ itemId: ITEM, positionMs: 0 })
    expect(repo.rows).toHaveLength(1)
  })

  it("keeps the handle to a row it could not close so a later close still lands", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })
    repo.failNext.finish = true
    await expect(tracker.finish({ positionMs: 60_000 })).rejects.toThrow("db locked")
    expect(repo.open()).toHaveLength(1)

    await tracker.finish({ positionMs: 61_000 })
    expect(repo.open()).toEqual([])
    expect(repo.rows[0].to).toBe(61)
  })

  it("keeps serving later calls after one of them threw", async () => {
    const tracker = trackerWith(repo)
    await tracker.start({ itemId: ITEM, positionMs: 0 })
    repo.failNext.finish = true
    await expect(tracker.finish({ positionMs: 10_000 })).rejects.toThrow()

    await tracker.forceStart({ itemId: OTHER, positionMs: 0 })
    expect(tracker.activeItemId()).toBe(OTHER)
  })
})

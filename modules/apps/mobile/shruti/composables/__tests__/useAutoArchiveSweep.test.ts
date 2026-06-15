import { describe, expect, it, vi } from "vitest"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import {
  autoArchiveDelayMs,
  runAutoArchiveSweep,
  type AutoArchiveSweepDeps,
} from "../useAutoArchiveSweep.js"

function track(id: string, durationMs: number): Track {
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "1970-01-01" as Track["date"],
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [
      {
        trackId: id as TrackId,
        language: "en" as Track["variants"][number]["language"],
        title: id,
        audios: [{ path: "", filesize: null, duration: durationMs, kind: "original" }],
        audio: {
          path: "",
          filesize: null,
          duration: durationMs,
          kind: "original",
        },
        transcript: null,
        outline: null,
        description: null,
      },
    ],
  }
}

function deps(
  overrides: Partial<AutoArchiveSweepDeps>,
  archiveSpy = vi.fn().mockResolvedValue(undefined)
): { d: AutoArchiveSweepDeps; archiveSpy: ReturnType<typeof vi.fn> } {
  const base: AutoArchiveSweepDeps = {
    listActive: async () => [],
    getTracks: async () => new Map(),
    getCompletedAt: async () => new Map(),
    archive: archiveSpy,
    now: () => 0,
    ...overrides,
  }
  return { d: base, archiveSpy }
}

describe("autoArchiveDelayMs", () => {
  it("returns null for 'off' so callers can short-circuit", () => {
    expect(autoArchiveDelayMs("off")).toBeNull()
  })
  it("maps named buckets to ms", () => {
    expect(autoArchiveDelayMs("immediate")).toBe(0)
    expect(autoArchiveDelayMs("8h")).toBe(8 * 3_600_000)
    expect(autoArchiveDelayMs("1d")).toBe(86_400_000)
    expect(autoArchiveDelayMs("2d")).toBe(2 * 86_400_000)
    expect(autoArchiveDelayMs("3d")).toBe(3 * 86_400_000)
  })
})

describe("runAutoArchiveSweep", () => {
  const NOW = 10 * 86_400_000 // arbitrary "now"

  it("short-circuits when the setting is off — no DB calls", async () => {
    const listActive = vi.fn()
    const { d } = deps({ listActive, now: () => NOW })
    const archived = await runAutoArchiveSweep("off", d)
    expect(archived).toEqual([])
    expect(listActive).not.toHaveBeenCalled()
  })

  it("does nothing when the playlist has no items", async () => {
    const { d, archiveSpy } = deps({
      listActive: async () => [],
      now: () => NOW,
    })
    const archived = await runAutoArchiveSweep("immediate", d)
    expect(archived).toEqual([])
    expect(archiveSpy).not.toHaveBeenCalled()
  })

  it("archives items whose completion is older than the chosen delay", async () => {
    const oldId = "old" as PlaylistItemId
    const freshId = "fresh" as PlaylistItemId
    // 9h ago — past the 8h delay
    const oldCompletedSec = (NOW - 9 * 3_600_000) / 1000
    // 4h ago — still inside the 8h delay
    const freshCompletedSec = (NOW - 4 * 3_600_000) / 1000

    const { d, archiveSpy } = deps({
      listActive: async () => [
        { id: oldId, trackId: "t1" as TrackId },
        { id: freshId, trackId: "t2" as TrackId },
      ],
      getTracks: async () =>
        new Map([
          ["t1" as TrackId, track("t1", 60_000)],
          ["t2" as TrackId, track("t2", 60_000)],
        ]),
      getCompletedAt: async () =>
        new Map([
          [oldId, oldCompletedSec],
          [freshId, freshCompletedSec],
        ]),
      now: () => NOW,
    })

    const archived = await runAutoArchiveSweep("8h", d)
    expect(archived).toEqual([oldId])
    expect(archiveSpy).toHaveBeenCalledTimes(1)
    expect(archiveSpy).toHaveBeenCalledWith(oldId)
  })

  it("archives 'immediate' items as soon as completion is set", async () => {
    const id = "i" as PlaylistItemId
    const { d, archiveSpy } = deps({
      listActive: async () => [{ id, trackId: "t" as TrackId }],
      getTracks: async () => new Map([["t" as TrackId, track("t", 60_000)]]),
      // Completed "now" — age 0 is still >= 0 for 'immediate'.
      getCompletedAt: async () => new Map([[id, NOW / 1000]]),
      now: () => NOW,
    })
    const archived = await runAutoArchiveSweep("immediate", d)
    expect(archived).toEqual([id])
    expect(archiveSpy).toHaveBeenCalledOnce()
  })

  it("skips items that have not completed yet", async () => {
    const id = "u" as PlaylistItemId
    const { d, archiveSpy } = deps({
      listActive: async () => [{ id, trackId: "t" as TrackId }],
      getTracks: async () => new Map([["t" as TrackId, track("t", 60_000)]]),
      getCompletedAt: async () => new Map([[id, null]]),
      now: () => NOW,
    })
    const archived = await runAutoArchiveSweep("1d", d)
    expect(archived).toEqual([])
    expect(archiveSpy).not.toHaveBeenCalled()
  })

  it("ignores items whose track row is missing (stale playlist entry)", async () => {
    const id = "m" as PlaylistItemId
    const { d, archiveSpy } = deps({
      listActive: async () => [{ id, trackId: "ghost" as TrackId }],
      getTracks: async () => new Map(),
      // The sessions repo only gets items it has a duration for — so the
      // mock returns an empty map, mirroring real behaviour.
      getCompletedAt: async () => new Map(),
      now: () => NOW,
    })
    const archived = await runAutoArchiveSweep("immediate", d)
    expect(archived).toEqual([])
    expect(archiveSpy).not.toHaveBeenCalled()
  })
})

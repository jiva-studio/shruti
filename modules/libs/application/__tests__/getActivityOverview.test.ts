import { describe, expect, it } from "vitest"
import { getActivityOverview } from "../getActivityOverview.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"

function makeListeningSessions(
  totalsByDate: Record<string, number> = {}
): IListeningSessionRepository {
  return {
    start: async () => {
      throw new Error("not stubbed")
    },
    forceStart: async () => {
      throw new Error("not stubbed")
    },
    tick: async () => {},
    finish: async () => {},
    getLastSessionForItem: async () => null,
    getProgressForItems: async () => new Map(),
    getCompletedAtForItems: async () => new Map(),
    getDailyTotals: async () =>
      Object.entries(totalsByDate).map(([date, listenedSeconds]) => ({
        date,
        listenedSeconds,
      })),
    getTotalListenedSeconds: async () => 0,
  }
}

function makePlaylistItems(): IPlaylistItemRepository {
  return {
    getById: async () => null,
    listActive: async () => [],
    listArchived: async () => [],
    add: async () => {
      throw new Error("not stubbed")
    },
    archive: async () => {},
    remove: async () => {},
    clearAll: async () => {},
  }
}

function makeTracks(): ITrackRepository {
  return {
    getById: async () => null,
    getByIds: async () => new Map(),
    list: async () => [],
    search: async () => [],
    getTranscriptPath: async () => null,
    listTranscriptLanguages: async () => [],
  } as unknown as ITrackRepository
}

const DAY = 86_400_000

describe("getActivityOverview", () => {
  it("anchors the today-cell on nowMs, not on the toMs query bound", async () => {
    // Real "now" is mid-2026. `toMs` sits ~225 days in the future, as
    // the caller in useActivityHeatmap deliberately over-queries to
    // include the look-ahead buffer. A previous regression treated
    // `toMs` as "now", pushing today's cell to the right edge.
    const nowMs = new Date(2026, 4, 13, 12, 0, 0, 0).getTime()
    const toMs = nowMs + 225 * DAY
    const fromMs = nowMs - 224 * DAY

    const overview = await getActivityOverview(
      { fromMs, toMs, nowMs, totalDays: 224 },
      {
        listeningSessions: makeListeningSessions({ "2026-05-13": 600 }),
        playlistItems: makePlaylistItems(),
        tracks: makeTracks(),
      }
    )

    const todayCells = overview.days.filter((d) => d.isToday)
    expect(todayCells).toHaveLength(1)
    expect(todayCells[0].date).toBe("2026-05-13")
    expect(todayCells[0].listenedSeconds).toBe(600)
  })

  it("keeps today in the left half of the grid when history is short", async () => {
    // ~10 days of history → today should be 1–2 columns from the left,
    // not clamped at the right edge. This is the symptom of the bug:
    // with `toMs` (≈now+225d) used as the anchor, `daysBack` clamped to
    // `totalDays - 7 = 217` and today landed at column 31.
    const nowMs = new Date(2026, 4, 13, 12, 0, 0, 0).getTime()
    const toMs = nowMs + 225 * DAY
    const fromMs = nowMs - 224 * DAY

    const overview = await getActivityOverview(
      { fromMs, toMs, nowMs, totalDays: 224 },
      {
        listeningSessions: makeListeningSessions({
          "2026-05-04": 300,
          "2026-05-13": 600,
        }),
        playlistItems: makePlaylistItems(),
        tracks: makeTracks(),
      }
    )

    const todayIdx = overview.days.findIndex((d) => d.isToday)
    const todayCol = Math.floor(todayIdx / 7)
    expect(todayCol).toBeLessThanOrEqual(2)
  })

  it("computes streak ending at the real today, not at toMs", async () => {
    const nowMs = new Date(2026, 4, 13, 12, 0, 0, 0).getTime()
    const toMs = nowMs + 225 * DAY
    const fromMs = nowMs - 224 * DAY

    const overview = await getActivityOverview(
      { fromMs, toMs, nowMs, totalDays: 224 },
      {
        listeningSessions: makeListeningSessions({
          "2026-05-11": 300,
          "2026-05-12": 300,
          "2026-05-13": 600,
        }),
        playlistItems: makePlaylistItems(),
        tracks: makeTracks(),
      }
    )

    expect(overview.currentStreak).toBe(3)
  })
})

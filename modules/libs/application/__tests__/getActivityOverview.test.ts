import { describe, expect, it } from "vitest"
import { getActivityOverview } from "../getActivityOverview.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"

function makeListeningSessions(
  totalsByDate: Record<string, number> = {},
  completedItemIds: readonly PlaylistItemId[] = []
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
    getCompletedAtForItems: async (itemIds) => {
      const completed = new Set<string>(completedItemIds)
      const out = new Map<PlaylistItemId, number | null>()
      for (const id of itemIds) out.set(id, completed.has(id) ? 1 : null)
      return out
    },
    getDailyTotals: async () =>
      Object.entries(totalsByDate).map(([date, listenedSeconds]) => ({
        date,
        listenedSeconds,
      })),
    getDailyTotalsByDayOffset: async () => [],
    getTotalListenedSeconds: async () => 0,
    listRecentTracksWithProgress: async () => [],
    getTracksListenedInRange: async () => [],
    clearAll: async () => {},
  }
}

function makePlaylistItems(
  init: { active?: readonly PlaylistItem[]; archived?: readonly PlaylistItem[] } = {}
): IPlaylistItemRepository {
  return {
    getById: async () => null,
    listActive: async () => init.active ?? [],
    listArchived: async () => init.archived ?? [],
    add: async () => {
      throw new Error("not stubbed")
    },
    archive: async () => {},
    remove: async () => {},
    clearAll: async () => {},
  }
}

function makeTracks(tracks: readonly Track[] = []): ITrackRepository {
  const byId = new Map<TrackId, Track>(tracks.map((t) => [t.id, t]))
  return {
    getById: async (id: TrackId) => byId.get(id) ?? null,
    getByIds: async (ids: readonly TrackId[]) => {
      const out = new Map<TrackId, Track>()
      for (const id of ids) {
        const t = byId.get(id)
        if (t) out.set(id, t)
      }
      return out
    },
    list: async () => [],
    search: async () => [],
    getTranscriptPath: async () => null,
    listTranscriptLanguages: async () => [],
  } as unknown as ITrackRepository
}

function makeItem(id: string, trackId: string, archivedAt: number | null = null): PlaylistItem {
  return {
    id: id as PlaylistItemId,
    trackId: trackId as TrackId,
    addedAt: 0,
    archivedAt,
    collectionId: null,
  }
}

function makeTrack(id: string, durationMs = 600_000): Track {
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "1970-01-01",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [
      {
        trackId: id as TrackId,
        language: "en",
        title: id,
        audios: [{ path: `audio/${id}.mp3`, filesize: null, duration: durationMs, kind: "original" }],
        audio: { path: `audio/${id}.mp3`, filesize: null, duration: durationMs, kind: "original" },
        transcript: null,
      },
    ],
  } as unknown as Track
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

  it("counts archived items toward completedCount (issue #470 follow-up)", async () => {
    // Archive only flips `archived_at` — `listening_sessions` is
    // untouched, so completed lectures that the user then archived
    // must still show in the Activity tab's completedCount badge.
    const nowMs = new Date(2026, 4, 13, 12, 0, 0, 0).getTime()
    const toMs = nowMs + 225 * DAY
    const fromMs = nowMs - 224 * DAY

    const active = [makeItem("i-active-1", "t-a1"), makeItem("i-active-2", "t-a2")]
    const archived = [
      makeItem("i-arch-1", "t-r1", nowMs - DAY),
      makeItem("i-arch-2", "t-r2", nowMs - DAY),
    ]
    const tracks = [makeTrack("t-a1"), makeTrack("t-a2"), makeTrack("t-r1"), makeTrack("t-r2")]

    const overview = await getActivityOverview(
      { fromMs, toMs, nowMs, totalDays: 224 },
      {
        listeningSessions: makeListeningSessions(
          {},
          ["i-active-1", "i-arch-1", "i-arch-2"] as PlaylistItemId[]
        ),
        playlistItems: makePlaylistItems({ active, archived }),
        tracks: makeTracks(tracks),
      }
    )

    expect(overview.completedCount).toBe(3)
  })
})

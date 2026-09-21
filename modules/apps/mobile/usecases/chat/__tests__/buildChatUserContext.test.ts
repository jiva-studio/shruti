import { describe, expect, it } from "vitest"
import type { TrackId } from "@lib/domain/core.js"
import { buildChatUserContext, type BuildChatUserContextDeps } from "../buildChatUserContext.js"

const NOW = Date.parse("2026-05-17T16:42:00Z")

function deps(over: Partial<BuildChatUserContextDeps> = {}): BuildChatUserContextDeps {
  return {
    now: () => NOW,
    listeningSessions: { listRecentTracksWithProgress: async () => [] } as never,
    tracks: { getDurationsMs: async () => new Map() } as never,
    ...over,
  }
}

function recents(rows: { trackId: string; positionSec: number; endedAtMs: number }[]) {
  return { listRecentTracksWithProgress: async () => rows } as never
}

function durations(map: Record<string, number>) {
  return {
    getDurationsMs: async () => new Map(Object.entries(map)) as Map<TrackId, number>,
  } as never
}

describe("buildChatUserContext", () => {
  it("stamps now as local wall-clock with the device offset, never Z", async () => {
    const payload = await buildChatUserContext({ currentTrackId: null }, deps())
    expect(payload.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(payload.now).not.toMatch(/Z$/)
    expect(Date.parse(payload.now)).toBe(NOW)
  })

  it("carries the current track and omits focus when there is none", async () => {
    const payload = await buildChatUserContext({ currentTrackId: "t1" }, deps())
    expect(payload.current_track_id).toBe("t1")
    expect("focus" in payload).toBe(false)
  })

  it("carries a focus span when the user re-asked about one", async () => {
    const focus = { track_id: "t1", start_ms: 10, end_ms: 20, title: "A span" }
    const payload = await buildChatUserContext({ currentTrackId: null, focus }, deps())
    expect(payload.focus).toEqual(focus)
  })

  it("derives percent from the track's duration", async () => {
    const payload = await buildChatUserContext(
      { currentTrackId: null },
      deps({
        listeningSessions: recents([{ trackId: "t1", positionSec: 30, endedAtMs: NOW }]),
        tracks: durations({ t1: 60_000 }),
      })
    )
    expect(payload.recent_tracks[0]).toMatchObject({
      track_id: "t1",
      position_ms: 30_000,
      percent: 0.5,
    })
  })

  it("reports no percent when the duration is unknown or zero", async () => {
    for (const map of [{} as Record<string, number>, { t1: 0 }]) {
      const payload = await buildChatUserContext(
        { currentTrackId: null },
        deps({
          listeningSessions: recents([{ trackId: "t1", positionSec: 30, endedAtMs: NOW }]),
          tracks: durations(map),
        })
      )
      expect(payload.recent_tracks[0].percent).toBeNull()
    }
  })

  it("clamps a position past the end to a full track", async () => {
    const payload = await buildChatUserContext(
      { currentTrackId: null },
      deps({
        listeningSessions: recents([{ trackId: "t1", positionSec: 999, endedAtMs: NOW }]),
        tracks: durations({ t1: 60_000 }),
      })
    )
    expect(payload.recent_tracks[0].percent).toBe(1)
  })

  it("never reports a negative position", async () => {
    const payload = await buildChatUserContext(
      { currentTrackId: null },
      deps({
        listeningSessions: recents([{ trackId: "t1", positionSec: -5, endedAtMs: NOW }]),
        tracks: durations({ t1: 60_000 }),
      })
    )
    expect(payload.recent_tracks[0].position_ms).toBe(0)
    expect(payload.recent_tracks[0].percent).toBe(0)
  })

  it("asks for at most the recent window", async () => {
    let asked = -1
    await buildChatUserContext(
      { currentTrackId: null },
      deps({
        listeningSessions: {
          listRecentTracksWithProgress: async (n: number) => {
            asked = n
            return []
          },
        } as never,
      })
    )
    expect(asked).toBe(20)
  })

  it("still answers when the history read fails", async () => {
    const payload = await buildChatUserContext(
      { currentTrackId: "t1" },
      deps({
        listeningSessions: {
          listRecentTracksWithProgress: async () => {
            throw new Error("db gone")
          },
        } as never,
      })
    )
    expect(payload.recent_tracks).toEqual([])
    expect(payload.current_track_id).toBe("t1")
  })

  it("still answers, without percents, when the duration read fails", async () => {
    const payload = await buildChatUserContext(
      { currentTrackId: null },
      deps({
        listeningSessions: recents([{ trackId: "t1", positionSec: 30, endedAtMs: NOW }]),
        tracks: {
          getDurationsMs: async () => {
            throw new Error("db gone")
          },
        } as never,
      })
    )
    expect(payload.recent_tracks).toHaveLength(1)
    expect(payload.recent_tracks[0].percent).toBeNull()
  })

  it("stamps each play's end in the same local format as now", async () => {
    const payload = await buildChatUserContext(
      { currentTrackId: null },
      deps({ listeningSessions: recents([{ trackId: "t1", positionSec: 1, endedAtMs: NOW }]) })
    )
    expect(payload.recent_tracks[0].last_played_at).toBe(payload.now)
  })
})

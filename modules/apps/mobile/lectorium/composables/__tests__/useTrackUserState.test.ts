import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TrackId } from "@lib/domain/core.js"

interface PlayerState {
  open: boolean
  playing: boolean
  trackId: string | null
  positionMs: number | null
}

interface RecentRow {
  trackId: string
  positionSec: number
  endedAtMs: number
}

const player: PlayerState = { open: false, playing: false, trackId: null, positionMs: null }
let recent: RecentRow[] = []
let durations = new Map<TrackId, number>()
let requestedLimits: number[] = []

vi.mock("@lectorium/stores/usePlayerStore.js", () => ({
  usePlayerStore: () => player,
}))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      listeningSessions: {
        listRecentTracksWithProgress: async (limit: number) => {
          requestedLimits.push(limit)
          return recent
        },
      },
      tracks: { getDurationsMs: async () => durations },
    }),
  }),
}))

import { useTrackUserState } from "../useTrackUserState.js"

const NOW = Date.parse("2026-05-17T16:42:00Z")

describe("useTrackUserState", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    Object.assign(player, { open: false, playing: false, trackId: null, positionMs: null })
    recent = []
    durations = new Map()
    requestedLimits = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("currentTrackId", () => {
    it("is null while the player is closed, even mid-playback", () => {
      Object.assign(player, { open: false, playing: true, trackId: "t1", positionMs: 5_000 })
      expect(useTrackUserState().currentTrackId()).toBeNull()
    })

    it("is the playing track when the player is open", () => {
      Object.assign(player, { open: true, playing: true, trackId: "t1", positionMs: 0 })
      expect(useTrackUserState().currentTrackId()).toBe("t1")
    })

    it("keeps a paused track that has been played, but not one parked at zero", () => {
      Object.assign(player, { open: true, playing: false, trackId: "t1", positionMs: 1 })
      expect(useTrackUserState().currentTrackId()).toBe("t1")

      player.positionMs = 0
      expect(useTrackUserState().currentTrackId()).toBeNull()
    })

    it("is null for a paused player with no position at all", () => {
      Object.assign(player, { open: true, playing: false, trackId: "t1", positionMs: null })
      expect(useTrackUserState().currentTrackId()).toBeNull()
    })

    it("is null when the open player holds no track", () => {
      Object.assign(player, { open: true, playing: true, trackId: null, positionMs: 1_000 })
      expect(useTrackUserState().currentTrackId()).toBeNull()
    })
  })

  describe("buildUserContext", () => {
    it("reports the player's track and the device clock", async () => {
      Object.assign(player, { open: true, playing: true, trackId: "t1", positionMs: 3_000 })

      const payload = await useTrackUserState().buildUserContext()

      expect(payload.current_track_id).toBe("t1")
      expect(Date.parse(payload.now)).toBe(NOW)
    })

    it("passes the focus span through untouched", async () => {
      const focus = { track_id: "t9", start_ms: 1_000, end_ms: 2_000, title: "A span" }

      const payload = await useTrackUserState().buildUserContext(focus)

      expect(payload.focus).toEqual(focus)
    })

    it("includes the recent listening history with progress", async () => {
      recent = [{ trackId: "t1", positionSec: 30, endedAtMs: NOW }]
      durations = new Map([["t1" as TrackId, 60_000]])

      const payload = await useTrackUserState().buildUserContext()

      expect(payload.recent_tracks).toEqual([
        {
          track_id: "t1",
          position_ms: 30_000,
          percent: 0.5,
          last_played_at: payload.now,
        },
      ])
    })
  })

  describe("listRecent", () => {
    it("returns just the track ids, honouring the requested limit", async () => {
      recent = [
        { trackId: "t1", positionSec: 5, endedAtMs: NOW },
        { trackId: "t2", positionSec: 6, endedAtMs: NOW },
      ]

      const rows = await useTrackUserState().listRecent(1)

      expect(rows).toEqual([{ trackId: "t1" }, { trackId: "t2" }])
      expect(requestedLimits).toEqual([1])
    })

    it("is empty for a user who has never listened", async () => {
      expect(await useTrackUserState().listRecent(1)).toEqual([])
    })
  })
})

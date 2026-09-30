import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import { resolveTrackForItem } from "../resolveTrackForItem.js"

const TRACK = { id: "t-1" } as Track
const boom = new Error("database is locked")

function deps(over: { getItem?: () => Promise<unknown>; getTrack?: () => Promise<unknown> }) {
  return {
    playlistItems: {
      getById: over.getItem ?? (async () => ({ trackId: "t-1" as TrackId })),
    } as unknown as IPlaylistItemRepository,
    tracks: {
      getById: over.getTrack ?? (async () => TRACK),
    } as unknown as ITrackRepository,
  }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("resolveTrackForItem — reads that fail", () => {
  it("logs an item it cannot read and still resolves a synthetic id", async () => {
    const found = await resolveTrackForItem(
      "track:t-1" as PlaylistItemId,
      deps({ getItem: () => Promise.reject(boom) })
    )

    expect(found).toBe(TRACK)
    expect(warn).toHaveBeenCalledWith("[playlist] item read failed", boom)
  })

  it("logs a track it cannot read and answers unknown", async () => {
    const found = await resolveTrackForItem(
      "i-1" as PlaylistItemId,
      deps({ getTrack: () => Promise.reject(boom) })
    )

    expect(found).toBeUndefined()
    expect(warn).toHaveBeenCalledWith("[playlist] track read failed", boom)
  })
})

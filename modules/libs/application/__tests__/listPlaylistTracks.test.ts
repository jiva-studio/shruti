import { describe, expect, it } from "vitest"
import { listActivePlaylistTracks } from "../listPlaylistTracks.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Track } from "@lib/domain/track.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"

function makePlaylistRepo(items: readonly PlaylistItem[]): IPlaylistItemRepository {
  return {
    getById: async () => null,
    listActive: async () => items,
    listArchived: async () => [],
    add: async () => {
      throw new Error("add not stubbed")
    },
    archive: async () => {},
    remove: async () => {},
    clearAll: async () => {},
  }
}

function makeTrackRepo(tracks: ReadonlyMap<string, Track>): ITrackRepository {
  return {
    getById: async (id) => tracks.get(id) ?? null,
    list: async () => [],
    search: async () => [],
    getTranscriptPath: async () => null,
    listTranscriptLanguages: async () => [],
  }
}

const mkItem = (id: string, trackId: string): PlaylistItem => ({
  id: id as PlaylistItemId,
  trackId: trackId as TrackId,
  addedAt: 1000,
  archivedAt: null,
})

const mkTrack = (id: string): Track => ({
  id: id as TrackId,
  authorId: null,
  locationId: null,
  date: "2020-01-01",
  hidden: false,
  sortReference: "",
  sortDate: "2020-01-01",
  references: [],
  tagIds: [],
  variants: [],
})

describe("listActivePlaylistTracks", () => {
  it("joins playlist items with their hydrated tracks", async () => {
    const items = [mkItem("pi-1", "t-1"), mkItem("pi-2", "t-2")]
    const tracks = new Map([
      ["t-1", mkTrack("t-1")],
      ["t-2", mkTrack("t-2")],
    ])
    const result = await listActivePlaylistTracks(
      { playlistItems: makePlaylistRepo(items), tracks: makeTrackRepo(tracks) }
    )
    expect(result.total).toBe(2)
    expect(result.entries.map((e) => e.item.id)).toEqual(["pi-1", "pi-2"])
    expect(result.entries.map((e) => e.track.id)).toEqual(["t-1", "t-2"])
  })

  it("silently drops entries whose track disappeared from the catalogue", async () => {
    const items = [mkItem("pi-1", "t-1"), mkItem("pi-2", "t-gone")]
    const tracks = new Map([["t-1", mkTrack("t-1")]])
    const result = await listActivePlaylistTracks(
      { playlistItems: makePlaylistRepo(items), tracks: makeTrackRepo(tracks) }
    )
    expect(result.total).toBe(2)
    expect(result.entries.map((e) => e.item.id)).toEqual(["pi-1"])
  })

  it("applies limit/offset slicing before hydration", async () => {
    const items = [
      mkItem("pi-1", "t-1"),
      mkItem("pi-2", "t-2"),
      mkItem("pi-3", "t-3"),
    ]
    const tracks = new Map([
      ["t-1", mkTrack("t-1")],
      ["t-2", mkTrack("t-2")],
      ["t-3", mkTrack("t-3")],
    ])
    const result = await listActivePlaylistTracks(
      { playlistItems: makePlaylistRepo(items), tracks: makeTrackRepo(tracks) },
      { limit: 1, offset: 1 }
    )
    expect(result.total).toBe(3)
    expect(result.entries.map((e) => e.item.id)).toEqual(["pi-2"])
  })
})

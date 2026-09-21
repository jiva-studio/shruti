import { describe, expect, it } from "vitest"
import { addTracksToPlaylist, type PlaylistAdder } from "../addTracksToPlaylist.js"
import type { TrackId } from "@lib/domain/core.js"

function makeAdder(failOn?: TrackId): { adder: PlaylistAdder; added: TrackId[] } {
  const added: TrackId[] = []
  return {
    added,
    adder: {
      add: async (trackId) => {
        if (trackId === failOn) throw new Error("disk full")
        added.push(trackId)
      },
    },
  }
}

const ids = (...values: string[]): readonly TrackId[] => values as readonly TrackId[]

describe("addTracksToPlaylist", () => {
  it("adds every track of the batch, in the order given", async () => {
    const { adder, added } = makeAdder()
    const result = await addTracksToPlaylist(
      { trackIds: ids("t-1", "t-2", "t-3") },
      {
        playlist: adder,
      }
    )

    expect(result.ok).toBe(true)
    expect(added).toEqual(ids("t-1", "t-2", "t-3"))
  })

  it("refuses an empty batch instead of reporting a silent success", async () => {
    const { adder, added } = makeAdder()
    const result = await addTracksToPlaylist({ trackIds: [] }, { playlist: adder })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("empty-tracks")
    expect(added).toEqual([])
  })

  it("stops at the first track that cannot be persisted", async () => {
    const { adder, added } = makeAdder("t-2" as TrackId)
    const result = await addTracksToPlaylist(
      { trackIds: ids("t-1", "t-2", "t-3") },
      {
        playlist: adder,
      }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("playlist-add-failed")
    expect(added).toEqual(ids("t-1"))
  })

  it("adds one track at a time, never concurrently", async () => {
    const inFlight: number[] = []
    let active = 0
    const result = await addTracksToPlaylist(
      { trackIds: ids("t-1", "t-2", "t-3") },
      {
        playlist: {
          add: async () => {
            active += 1
            inFlight.push(active)
            await Promise.resolve()
            active -= 1
          },
        },
      }
    )

    expect(result.ok).toBe(true)
    expect(inFlight).toEqual([1, 1, 1])
  })
})

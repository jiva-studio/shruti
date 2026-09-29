import { describe, expect, it } from "vitest"
import type { Track } from "@lib/domain/track.js"
import type { IsoDate, LanguageCode, TrackId } from "@lib/domain/core.js"
import { pickUnfinishedTrack } from "../unfinishedLecture.js"

function track(id: string, durationMs: number, hidden = false): Track {
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "2026-01-01" as IsoDate,
    hidden,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [
      {
        language: "en" as LanguageCode,
        title: `title ${id}`,
        audio: { duration: durationMs },
      },
    ],
  } as unknown as Track
}

function corpus(...tracks: Track[]): ReadonlyMap<TrackId, Track> {
  return new Map(tracks.map((t) => [t.id, t]))
}

const HOUR_MS = 3_600_000

describe("pickUnfinishedTrack", () => {
  it("picks the first track inside the progress band", () => {
    const t = track("a", HOUR_MS)
    const picked = pickUnfinishedTrack([{ trackId: t.id, positionSec: 1800 }], corpus(t))
    expect(picked?.id).toBe(t.id)
  })

  it("skips a barely-sampled and an all-but-finished track", () => {
    const barely = track("a", HOUR_MS)
    const done = track("b", HOUR_MS)
    const good = track("c", HOUR_MS)
    const picked = pickUnfinishedTrack(
      [
        { trackId: barely.id, positionSec: 60 },
        { trackId: done.id, positionSec: 3500 },
        { trackId: good.id, positionSec: 600 },
      ],
      corpus(barely, done, good)
    )
    expect(picked?.id).toBe(good.id)
  })

  it("skips a hidden track and one missing from the catalog", () => {
    const hidden = track("a", HOUR_MS, true)
    const good = track("c", HOUR_MS)
    const picked = pickUnfinishedTrack(
      [
        { trackId: hidden.id, positionSec: 1800 },
        { trackId: "gone" as TrackId, positionSec: 1800 },
        { trackId: good.id, positionSec: 1800 },
      ],
      corpus(hidden, good)
    )
    expect(picked?.id).toBe(good.id)
  })

  it("skips a track with no measurable audio length", () => {
    const t = track("a", 0)
    expect(pickUnfinishedTrack([{ trackId: t.id, positionSec: 100 }], corpus(t))).toBeNull()
  })

  it("returns null for an empty history", () => {
    expect(pickUnfinishedTrack([], corpus())).toBeNull()
  })
})

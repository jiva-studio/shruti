import { describe, expect, it } from "vitest"
import { buildRecommendations, type BuildRecommendationsDeps } from "../buildRecommendations.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"

const mkTrack = (id: string): Track => ({
  id: id as TrackId,
  authorId: null,
  locationId: null,
  date: "2020-01-01",
  hidden: false,
  references: [],
  tagIds: [],
  topicIds: [],
  variants: [],
})

const noShuffle = <T>(items: readonly T[]): T[] => [...items]

const baseInput = {
  now: 1_000_000,
  languages: ["en"] as LanguageCode[],
  historyWindowMs: 1000,
  shelfTopics: 3,
  shelfSize: 12,
  recommendedSize: 3,
  isExcluded: () => false,
  shuffle: noShuffle,
}

function makeDeps(over: Partial<BuildRecommendationsDeps> = {}): BuildRecommendationsDeps {
  return {
    listeningSessions: { getTracksListenedInRange: async () => [] },
    topics: {
      weightsForTracks: async () => [],
      topicIdsWithTracksIn: async () => [],
      topTrackIds: async () => [],
    },
    tracks: { getByIds: async (ids) => new Map(ids.map((id) => [id, mkTrack(id)])) },
    ...over,
  }
}

describe("buildRecommendations", () => {
  it("ranks shelves by affinity (weight × listened seconds) and picks top per shelf", async () => {
    const deps = makeDeps({
      listeningSessions: {
        getTracksListenedInRange: async () => [
          { trackId: "h1" as TrackId, listenedSeconds: 100 },
          { trackId: "h2" as TrackId, listenedSeconds: 10 },
        ],
      },
      topics: {
        // h1 strongly on top:b, h2 weakly on topic:a → b outranks a.
        weightsForTracks: async () => [
          { trackId: "h1" as TrackId, topicId: "tb" as TopicId, weight: 1 },
          { trackId: "h2" as TrackId, topicId: "ta" as TopicId, weight: 1 },
        ],
        topicIdsWithTracksIn: async () => [],
        topTrackIds: async (topicId) =>
          topicId === ("tb" as TopicId) ? (["b1", "b2"] as TrackId[]) : (["a1"] as TrackId[]),
      },
    })
    const res = await buildRecommendations(baseInput, deps)
    expect(res.hasHistory).toBe(true)
    expect(res.shelves.map((s) => s.topicId)).toEqual(["tb", "ta"])
    // "Recommended" is the top pick from each shelf, in shelf order.
    expect(res.recommended.map((t) => t.id)).toEqual(["b1", "a1"])
  })

  it("excludes heard, completed and queued tracks from shelves", async () => {
    const deps = makeDeps({
      listeningSessions: {
        getTracksListenedInRange: async () => [{ trackId: "h1" as TrackId, listenedSeconds: 5 }],
      },
      topics: {
        weightsForTracks: async () => [
          { trackId: "h1" as TrackId, topicId: "tb" as TopicId, weight: 1 },
        ],
        topicIdsWithTracksIn: async () => [],
        // h1 is heard, x1 is externally excluded, keep1 survives.
        topTrackIds: async () => ["h1", "x1", "keep1"] as TrackId[],
      },
    })
    const res = await buildRecommendations(
      { ...baseInput, isExcluded: (id) => id === ("x1" as TrackId) },
      deps
    )
    expect(res.shelves[0]?.tracks.map((t) => t.id)).toEqual(["keep1"])
  })

  it("cold-starts on the first topics with no history (shuffle injected)", async () => {
    let shuffleCalled = false
    const shuffle = <T>(items: readonly T[]): T[] => {
      shuffleCalled = true
      return [...items]
    }
    const deps = makeDeps({
      topics: {
        weightsForTracks: async () => [],
        topicIdsWithTracksIn: async () => ["t1", "t2"] as TopicId[],
        topTrackIds: async (topicId) =>
          topicId === ("t1" as TopicId) ? (["c1"] as TrackId[]) : (["c2"] as TrackId[]),
      },
    })
    const res = await buildRecommendations({ ...baseInput, shuffle }, deps)
    expect(res.hasHistory).toBe(false)
    expect(res.shelves.map((s) => s.topicId)).toEqual(["t1", "t2"])
    // Cold-start recommended pool is shuffled.
    expect(shuffleCalled).toBe(true)
    expect(res.recommended.map((t) => t.id)).toEqual(["c1", "c2"])
  })
})

import { describe, expect, it, vi } from "vitest"
import {
  listSimilarTracksByTopic,
  type ListSimilarTracksByTopicDeps,
} from "../listSimilarTracksByTopic.js"
import type { Track } from "@lib/domain/track.js"
import type { TopicId, TrackId } from "@lib/domain/core.js"

const mkTrack = (id: string, topicIds: string[] = []): Track => ({
  id: id as TrackId,
  authorId: null,
  locationId: null,
  date: "2020-01-01",
  hidden: false,
  references: [],
  tagIds: [],
  topicIds: topicIds as TopicId[],
  variants: [],
})

function makeDeps(over: Partial<ListSimilarTracksByTopicDeps> = {}): ListSimilarTracksByTopicDeps {
  return {
    topics: { similarTrackIds: async () => [] },
    tracks: { getByIds: async (ids) => new Map(ids.map((id) => [id, mkTrack(id)])) },
    ...over,
  }
}

describe("listSimilarTracksByTopic", () => {
  it("seeds from the first N topics and returns neighbours in similarity order", async () => {
    const similarSpy = vi
      .fn<ListSimilarTracksByTopicDeps["topics"]["similarTrackIds"]>()
      .mockResolvedValue(["n1", "n2"] as TrackId[])
    const deps = makeDeps({ topics: { similarTrackIds: similarSpy } })
    const track = mkTrack("seed", ["a", "b", "c"])
    const res = await listSimilarTracksByTopic(
      { track, seedTopics: 2, languages: ["en"], limit: 5 },
      deps
    )
    expect(similarSpy).toHaveBeenCalledWith(["a", "b"], "seed", ["en"], 5)
    expect(res.map((t) => t.id)).toEqual(["n1", "n2"])
  })

  it("returns [] without touching the repo when the track has no topics", async () => {
    const similarSpy = vi.fn()
    const deps = makeDeps({ topics: { similarTrackIds: similarSpy } })
    const res = await listSimilarTracksByTopic(
      { track: mkTrack("seed", []), seedTopics: 5, languages: ["en"], limit: 5 },
      deps
    )
    expect(res).toEqual([])
    expect(similarSpy).not.toHaveBeenCalled()
  })

  it("returns [] when there are no neighbours", async () => {
    const deps = makeDeps({ topics: { similarTrackIds: async () => [] } })
    const res = await listSimilarTracksByTopic(
      { track: mkTrack("seed", ["a"]), seedTopics: 5, languages: ["en"], limit: 5 },
      deps
    )
    expect(res).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import type { Topic } from "@lib/domain/topic.js"
import type { TopicId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { pickLandingSections, type LandingPicksInput } from "../landingPicks.js"
import type { CollectionGroupView, GroupCollection } from "../landingSources.js"

function collection(id: string): GroupCollection {
  return { id, name: id }
}

function group(id: string, collectionIds: readonly string[]): CollectionGroupView {
  return { id, name: id, collections: collectionIds.map(collection) }
}

function topic(id: string): Topic {
  return { id: id as TopicId, names: new Map(), shortNames: new Map(), cover: null }
}

function track(id: string): Track {
  return { id } as unknown as Track
}

function input(overrides: Partial<LandingPicksInput> = {}): LandingPicksInput {
  return {
    topGroups: [],
    allCollections: [],
    topics: [],
    topicShortNamesById: new Map(),
    shelfTopicIds: new Set(),
    allowedTopicIds: null,
    lecturePool: [],
    ...overrides,
  }
}

describe("pickLandingSections", () => {
  it("leaves out the collections the shelves above already show", () => {
    const picks = pickLandingSections(
      input({
        topGroups: [group("g1", ["c1", "c2"])],
        allCollections: ["c1", "c2", "c3", "c4"].map(collection),
      })
    )
    expect(picks.otherCollections.map((c) => c.id).sort()).toEqual(["c3", "c4"])
  })

  it("caps each section", () => {
    const picks = pickLandingSections(
      input({
        allCollections: Array.from({ length: 20 }, (_, i) => collection(`c${i}`)),
        topics: Array.from({ length: 20 }, (_, i) => topic(`t${i}`)),
        lecturePool: Array.from({ length: 40 }, (_, i) => track(`l${i}`)),
      })
    )
    expect(picks.otherCollections).toHaveLength(4)
    expect(picks.topicTiles).toHaveLength(6)
    expect(picks.lectureSample).toHaveLength(10)
  })

  it("drops a topic already shown as a listening shelf", () => {
    const picks = pickLandingSections(
      input({
        topics: ["t1", "t2"].map(topic),
        shelfTopicIds: new Set(["t1" as TopicId]),
      })
    )
    expect(picks.topicTiles.map((t) => t.id)).toEqual(["t2"])
  })

  it("drops a topic with no lecture in the selected languages", () => {
    const picks = pickLandingSections(
      input({
        topics: ["t1", "t2"].map(topic),
        allowedTopicIds: new Set(["t2" as TopicId]),
      })
    )
    expect(picks.topicTiles.map((t) => t.id)).toEqual(["t2"])
  })

  it("shows every topic when no language filter applies", () => {
    const picks = pickLandingSections(input({ topics: ["t1", "t2"].map(topic) }))
    expect(picks.topicTiles.map((t) => t.id).sort()).toEqual(["t1", "t2"])
  })

  it("shows no tile when the filter matched nothing — an empty set is not no filter", () => {
    const picks = pickLandingSections(
      input({ topics: ["t1"].map(topic), allowedTopicIds: new Set() })
    )
    expect(picks.topicTiles).toEqual([])
  })

  it("labels a tile with its short name, falling back to the id", () => {
    const picks = pickLandingSections(
      input({
        topics: ["t1", "t2"].map(topic),
        topicShortNamesById: new Map([["t1", "Bhakti"]]),
      })
    )
    const byId = new Map(picks.topicTiles.map((t) => [t.id, t.name]))
    expect(byId.get("t1")).toBe("Bhakti")
    expect(byId.get("t2")).toBe("t2")
  })

  it("samples the lecture pool without inventing or repeating a lecture", () => {
    const pool = Array.from({ length: 40 }, (_, i) => track(`l${i}`))
    const picks = pickLandingSections(input({ lecturePool: pool }))
    const ids = picks.lectureSample.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(pool.some((t) => t.id === id)).toBe(true)
  })
})

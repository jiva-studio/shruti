import { describe, expect, it } from "vitest"
import type { LanguageCode, TopicId } from "@lib/domain/core.js"
import type { Topic } from "@lib/domain/topic.js"
import { loadOnboardingTopics, ONBOARDING_TOPICS_KEY } from "../loadOnboardingTopics.js"

function topic(id: string, en: string, ru: string): Topic {
  return {
    id: id as TopicId,
    names: new Map([
      ["en", `${en} full`],
      ["ru", `${ru} полное`],
    ]) as ReadonlyMap<LanguageCode, string>,
    shortNames: new Map([
      ["en", en],
      ["ru", ru],
    ]) as ReadonlyMap<LanguageCode, string>,
    cover: null,
  }
}

const ALL: Record<string, Topic> = {
  topic_a: topic("topic_a", "Karma", "Карма"),
  topic_b: topic("topic_b", "Soul", "Душа"),
  topic_c: topic("topic_c", "Family", "Семья"),
}

function fakeRepos(kv: string | null, usable: string[] = []) {
  return {
    settings: { get: async () => kv },
    topics: {
      getByIds: async (ids: readonly TopicId[]) =>
        ids.map((id) => ALL[id]).filter((t): t is Topic => t != null),
      topicIdsWithTracksIn: async () => usable as readonly TopicId[],
      // unused by the loader:
      getById: async () => null,
      listAll: async () => [],
      weightsForTracks: async () => [],
      topTrackIds: async () => [],
      similarTrackIds: async () => [],
    },
  }
}

describe("loadOnboardingTopics", () => {
  it("uses the curated list in order, resolving the language short name", async () => {
    const repos = fakeRepos(JSON.stringify(["topic_c", "topic_a"]))
    const out = await loadOnboardingTopics(repos, "ru" as LanguageCode, [])
    expect(out).toEqual([
      { id: "topic_c", label: "Семья" },
      { id: "topic_a", label: "Карма" },
    ])
  })

  it("falls back to topics-with-tracks when the key is unset", async () => {
    const repos = fakeRepos(null, ["topic_a", "topic_b"])
    const out = await loadOnboardingTopics(repos, "en" as LanguageCode, ["en"] as LanguageCode[])
    expect(out.map((t) => t.id)).toEqual(["topic_a", "topic_b"])
    expect(out[0].label).toBe("Karma")
  })

  it("ignores malformed curated JSON and falls back", async () => {
    const repos = fakeRepos("not json", ["topic_b"])
    const out = await loadOnboardingTopics(repos, "en" as LanguageCode, [])
    expect(out.map((t) => t.id)).toEqual(["topic_b"])
  })

  it("uses the canonical key", () => {
    expect(ONBOARDING_TOPICS_KEY).toBe("onboarding.topics")
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { Topic } from "@lib/domain/topic.js"
import type { TopicId } from "@lib/domain/core.js"

/**
 * Issue #1741 (6): `ensureLoaded()` returned early when a load was already in
 * flight instead of awaiting it. Callers read the dictionaries into plain refs
 * right after awaiting — `CollectionView.load` does — so a topic page opened
 * while another caller's load was running rendered with the raw id as its
 * title and no cover, permanently: those are refs, not computeds.
 */

const topic: Topic = {
  id: "T1" as TopicId,
  names: new Map([["en", "Bhakti"]]),
  shortNames: new Map([["en", "Bhakti"]]),
  cover: "cover.png",
}

/** Every dictionary query resolves on a later macrotask — the window a second
 *  caller used to slip through. */
function deferred<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0))
}

const listTopics = vi.fn(() => deferred([topic]))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      authors: { listAll: () => deferred([]) },
      languages: { listWithTracks: () => deferred([]) },
      locations: { listAll: () => deferred([]) },
      sources: { listAll: () => deferred([]) },
      tags: { listAll: () => deferred([]) },
      topics: { listAll: listTopics },
      tracks: { listYears: () => deferred([]) },
    }),
  }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ({ value: "en" }),
}))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ({ value: ["en"] }),
}))

import { useDictionariesStore } from "../useDictionariesStore.js"

describe("useDictionariesStore.ensureLoaded", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listTopics.mockClear()
  })

  it("does not resolve until the in-flight load has actually loaded", async () => {
    const store = useDictionariesStore()

    // A first caller (the landing prefetch, say) starts the hydration…
    const first = store.ensureLoaded()
    // …and a second caller — the topic page the user just opened — awaits it.
    await store.ensureLoaded()

    // Resolving early hands the view empty dictionaries, and the view reads
    // them ONCE into refs: the page keeps the raw id as its title forever.
    expect(store.topics.map((t) => t.id)).toEqual(["T1"])
    expect(store.topicsById.get("T1" as TopicId)?.names.get("en")).toBe("Bhakti")
    await first
  })

  it("shares one hydration between concurrent callers", async () => {
    const store = useDictionariesStore()
    await Promise.all([store.ensureLoaded(), store.ensureLoaded(), store.ensureLoaded()])
    expect(listTopics).toHaveBeenCalledTimes(1)
  })

  it("short-circuits once loaded", async () => {
    const store = useDictionariesStore()
    await store.ensureLoaded()
    await store.ensureLoaded()
    expect(listTopics).toHaveBeenCalledTimes(1)
  })
})

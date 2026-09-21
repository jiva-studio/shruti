import { describe, expect, it } from "vitest"
import type { TrackId } from "@lib/domain/core.js"
import type { ILibraryItemRepository } from "@lib/domain/ports/libraryItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import { createCompositeTrackRepository } from "../compositeTrackRepository.js"

function variant(over: Partial<TrackVariant> = {}): TrackVariant {
  return {
    trackId: "t1",
    language: "en",
    title: "A lecture",
    audios: [],
    audio: null,
    transcript: null,
    outline: null,
    description: null,
    ...over,
  }
}

function track(id: TrackId, variants: readonly TrackVariant[] = []): Track {
  return {
    id,
    authorId: null,
    locationId: null,
    date: null,
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants,
  }
}

/** A corpus repository holding `tracks`; every collection read answers from it. */
function corpusOf(tracks: readonly Track[]): ITrackRepository {
  const byId = new Map(tracks.map((t) => [t.id, t]))
  return {
    getById: async (id) => byId.get(id) ?? null,
    getByIds: async (ids) => new Map(ids.filter((i) => byId.has(i)).map((i) => [i, byId.get(i)!])),
    list: async () => tracks,
    search: async () => tracks,
    count: async () => tracks.length,
    listYears: async () => [2024],
    findByReference: async () => tracks[0] ?? null,
    getTranscriptPath: async (id, language) =>
      byId.get(id)?.variants.find((v) => v.language === language)?.transcript?.path ?? null,
    listTranscriptLanguages: async (id) =>
      (byId.get(id)?.variants ?? []).filter((v) => v.transcript).map((v) => v.language),
    getDurationsMs: async (ids) =>
      new Map(
        ids
          .map((i) => [i, byId.get(i)?.variants[0]?.audio?.duration] as const)
          .filter((e): e is readonly [TrackId, number] => typeof e[1] === "number")
          .map(([i, d]) => [i, d])
      ),
    getAudioSizesBytes: async (ids) =>
      new Map(
        ids
          .map((i) => [i, byId.get(i)?.variants[0]?.audio?.filesize] as const)
          .filter((e): e is readonly [TrackId, number] => typeof e[1] === "number")
          .map(([i, s]) => [i, s])
      ),
  }
}

function libraryOf(tracks: readonly Track[]): ILibraryItemRepository {
  const byId = new Map(tracks.map((t) => [t.id, t]))
  return {
    getById: async () => null,
    getByTrackId: async () => null,
    listAll: async () => [],
    getTrackByTrackId: async (id) => byId.get(id) ?? null,
    clearAll: async () => {},
  }
}

describe("compositeTrackRepository", () => {
  it("answers a corpus id from the corpus", async () => {
    const repo = createCompositeTrackRepository(corpusOf([track("corpus1")]), libraryOf([]))
    expect((await repo.getById("corpus1"))?.id).toBe("corpus1")
  })

  it("falls back to the personal library for an id the corpus lacks", async () => {
    const repo = createCompositeTrackRepository(corpusOf([]), libraryOf([track("mine1")]))
    expect((await repo.getById("mine1"))?.id).toBe("mine1")
  })

  it("has nothing for an id neither source holds", async () => {
    const repo = createCompositeTrackRepository(corpusOf([]), libraryOf([]))
    expect(await repo.getById("nowhere")).toBeNull()
  })

  it("resolves a mixed batch from both sources", async () => {
    const repo = createCompositeTrackRepository(
      corpusOf([track("corpus1")]),
      libraryOf([track("mine1")])
    )
    const map = await repo.getByIds(["corpus1", "mine1", "nowhere"])
    expect([...map.keys()].sort()).toEqual(["corpus1", "mine1"])
  })

  it("keeps collection reads on the corpus alone", async () => {
    const repo = createCompositeTrackRepository(
      corpusOf([track("corpus1")]),
      libraryOf([track("mine1")])
    )
    expect((await repo.list({})).map((t) => t.id)).toEqual(["corpus1"])
    expect((await repo.search({ text: "x" })).map((t) => t.id)).toEqual(["corpus1"])
    expect(await repo.count()).toBe(1)
    expect(await repo.listYears()).toEqual([2024])
    expect((await repo.findByReference("bg", ["2"], ["en"]))?.id).toBe("corpus1")
  })

  it("takes a library track's transcript in the language that was asked for", async () => {
    const bilingual = track("mine1", [
      variant({ language: "ru", transcript: { path: "ru.json", kind: "original" } }),
      variant({ language: "en", transcript: { path: "en.json", kind: "generated" } }),
    ])
    const repo = createCompositeTrackRepository(corpusOf([]), libraryOf([bilingual]))
    expect(await repo.getTranscriptPath("mine1", "en")).toBe("en.json")
    expect(await repo.getTranscriptPath("mine1", "ru")).toBe("ru.json")
  })

  it("has no transcript path for a language the library track lacks", async () => {
    const repo = createCompositeTrackRepository(
      corpusOf([]),
      libraryOf([track("mine1", [variant({ language: "ru" })])])
    )
    expect(await repo.getTranscriptPath("mine1", "en")).toBeNull()
  })

  it("prefers the corpus transcript path when the corpus has one", async () => {
    const corpusTrack = track("t1", [
      variant({ transcript: { path: "corpus.json", kind: "original" } }),
    ])
    const libraryTrack = track("t1", [
      variant({ transcript: { path: "library.json", kind: "original" } }),
    ])
    const repo = createCompositeTrackRepository(corpusOf([corpusTrack]), libraryOf([libraryTrack]))
    expect(await repo.getTranscriptPath("t1", "en")).toBe("corpus.json")
  })

  it("lists every language a library track has a transcript in", async () => {
    const repo = createCompositeTrackRepository(
      corpusOf([]),
      libraryOf([
        track("mine1", [
          variant({ language: "ru", transcript: { path: "ru.json", kind: "original" } }),
          variant({ language: "en" }),
        ]),
      ])
    )
    expect(await repo.listTranscriptLanguages("mine1")).toEqual(["ru"])
  })

  it("lists no language for an id neither source holds", async () => {
    const repo = createCompositeTrackRepository(corpusOf([]), libraryOf([]))
    expect(await repo.listTranscriptLanguages("nowhere")).toEqual([])
  })

  it("takes a library track's duration and size from its audio", async () => {
    const mine = track("mine1", [
      variant({
        audio: { path: "a.mp3", filesize: 2048, duration: 90_000, kind: "original" },
      }),
    ])
    const repo = createCompositeTrackRepository(corpusOf([]), libraryOf([mine]))
    expect(await repo.getDurationsMs(["mine1"])).toEqual(new Map([["mine1", 90_000]]))
    expect(await repo.getAudioSizesBytes(["mine1"])).toEqual(new Map([["mine1", 2048]]))
  })

  it("reports no size for a library track whose audio size is unknown", async () => {
    const mine = track("mine1", [
      variant({ audio: { path: "a.mp3", filesize: 0, duration: null, kind: "original" } }),
    ])
    const repo = createCompositeTrackRepository(corpusOf([]), libraryOf([mine]))
    expect((await repo.getAudioSizesBytes(["mine1"])).size).toBe(0)
    expect((await repo.getDurationsMs(["mine1"])).size).toBe(0)
  })

  it("merges corpus and library durations in one batch", async () => {
    const corpusTrack = track("corpus1", [
      variant({ audio: { path: "c.mp3", filesize: 10, duration: 1000, kind: "original" } }),
    ])
    const libraryTrack = track("mine1", [
      variant({ audio: { path: "m.mp3", filesize: 20, duration: 2000, kind: "original" } }),
    ])
    const repo = createCompositeTrackRepository(corpusOf([corpusTrack]), libraryOf([libraryTrack]))
    expect(await repo.getDurationsMs(["corpus1", "mine1"])).toEqual(
      new Map([
        ["corpus1", 1000],
        ["mine1", 2000],
      ])
    )
  })
})

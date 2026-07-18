import { describe, expect, it } from "vitest"
import { computeNextTokens, nextShlokaRule } from "../nextShloka.js"
import type { ProactiveContext } from "../../types.js"
import type { LanguageCode, SourceId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

describe("computeNextTokens", () => {
  it("increments the last numeric token by one", () => {
    expect(computeNextTokens(["2", "13"])).toEqual(["2", "14"])
    expect(computeNextTokens(["1"])).toEqual(["2"])
    expect(computeNextTokens(["3", "1", "1"])).toEqual(["3", "1", "2"])
  })

  it("takes the upper bound on ranges (e.g. 13-14 -> 15)", () => {
    expect(computeNextTokens(["2", "13-14"])).toEqual(["2", "15"])
    expect(computeNextTokens(["2", "13-15"])).toEqual(["2", "16"])
  })

  it("returns null when the last token is non-numeric", () => {
    // Wouldn't normally happen, but worth guarding so the rule fails
    // closed rather than guessing.
    expect(computeNextTokens(["2", "intro"])).toBeNull()
    expect(computeNextTokens([])).toBeNull()
  })

  it("returns null on padded/decorated numerals to keep lookups exact", () => {
    expect(computeNextTokens(["02"])).toBeNull()
    expect(computeNextTokens(["13a"])).toBeNull()
  })
})

const SRC = "src_bg" as SourceId

/** Minimal track with one reference and a variant per language. */
function track(id: string, tokens: readonly string[], languages: readonly LanguageCode[]): Track {
  return {
    id: id as TrackId,
    references: [{ sourceId: SRC, tokens }],
    variants: languages.map((language) => ({
      trackId: id as TrackId,
      language,
      title: `${id} (${language})`,
      audios: [],
      audio: null,
      transcript: null,
    })),
  } as unknown as Track
}

/**
 * Fake repos honouring the `languages` filter of `findByReference` the way the
 * SQL repo does: a track matches only if it carries a variant in one of the
 * requested languages (empty = any). `recent` is the newest-first listening list.
 */
function ctx(over: {
  recent: readonly string[]
  corpus: readonly Track[]
  libraryLanguages: readonly LanguageCode[]
}): ProactiveContext {
  const byId = new Map(over.corpus.map((t) => [t.id, t]))
  const recentTracks = over.recent.map((id) => byId.get(id as TrackId)!).filter(Boolean)
  return {
    libraryLanguages: over.libraryLanguages,
    locale: "en",
    t: (k: string) => k,
    repos: {
      // `detect` reads sources only to localise the verse label in the
      // session title; an empty dictionary makes `formatReference` fall
      // back to the raw source id, which is fine for these assertions.
      sources: {
        async listAll() {
          return []
        },
      },
      listeningSessions: {
        async listRecentTracksWithProgress() {
          return recentTracks.map((t, i) => ({
            trackId: t.id,
            endedAtMs: 1000 - i,
            positionSec: 0,
          }))
        },
      },
      tracks: {
        async getByIds(ids: readonly TrackId[]) {
          return new Map(
            ids.map((id) => [id, byId.get(id)]).filter(([, t]) => t) as [TrackId, Track][]
          )
        },
        async findByReference(
          sourceId: SourceId,
          tokens: readonly string[],
          languages?: readonly LanguageCode[]
        ) {
          const key = tokens.join(".")
          return (
            over.corpus.find(
              (t) =>
                t.references.some((r) => r.sourceId === sourceId && r.tokens.join(".") === key) &&
                (!languages ||
                  languages.length === 0 ||
                  t.variants.some((v) => languages.includes(v.language)))
            ) ?? null
          )
        },
      },
    },
  } as unknown as ProactiveContext
}

describe("next_shloka rule — library language", () => {
  it("suggests the next verse when a lecture exists in the library language", async () => {
    const out = await nextShlokaRule.detect(
      ctx({
        recent: ["listened_ru"],
        corpus: [track("listened_ru", ["2", "13"], ["ru"]), track("next_ru", ["2", "14"], ["ru"])],
        libraryLanguages: ["ru"],
      }),
      {} as never
    )
    expect(out).toHaveLength(1)
    expect(out[0].ruleDate).toBe("next_ru")
    // Title names the specific verse so successive nudges read distinctly
    // (empty source dict → raw source id "src_bg", real dict → "BG").
    expect(out[0].sessionTitleOverride).toBe("chat.proactiveSessionTitleNextShloka — src_bg 2.14")
  })

  it("stays silent when the next verse only exists in another language", async () => {
    // The regression: user's library is Russian, but the only lecture for the
    // next verse is English → no nudge (not an English card).
    const out = await nextShlokaRule.detect(
      ctx({
        recent: ["listened_ru"],
        corpus: [track("listened_ru", ["2", "13"], ["ru"]), track("next_en", ["2", "14"], ["en"])],
        libraryLanguages: ["ru"],
      }),
      {} as never
    )
    expect(out).toEqual([])
  })

  it("allows any language when no library filter is set", async () => {
    const out = await nextShlokaRule.detect(
      ctx({
        recent: ["listened_ru"],
        corpus: [track("listened_ru", ["2", "13"], ["ru"]), track("next_en", ["2", "14"], ["en"])],
        libraryLanguages: [],
      }),
      {} as never
    )
    expect(out).toHaveLength(1)
    expect(out[0].ruleDate).toBe("next_en")
  })
})

import { describe, expect, it } from "vitest"
import { dailyWisdomRule } from "../dailyWisdom.js"
import type { ProactiveContext } from "../../types.js"
import type { DailyWisdom } from "@lib/domain/dailyWisdom.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"

function frag(id: string, language: LanguageCode): DailyWisdom {
  return {
    id,
    trackId: "track_x" as TrackId,
    language,
    startMs: 0,
    endMs: 1000,
    text: `text ${id}`,
    topicId: "topic_a" as TopicId,
  }
}

/** A fake daily_wisdom repo that honours the `language` filter the way the SQL
 *  repo does. Only `list`/`byId` are exercised by the rule now. */
function fakeRepo(corpus: readonly DailyWisdom[]) {
  const inLang = (w: DailyWisdom, lang?: LanguageCode) => lang === undefined || w.language === lang
  return {
    async list(lang?: LanguageCode) {
      return corpus.filter((w) => inLang(w, lang))
    },
    async byId(id: string) {
      return corpus.find((w) => w.id === id) ?? null
    },
  }
}

function ctx(over: {
  corpus: readonly DailyWisdom[]
  libraryLanguages: readonly LanguageCode[]
  notificationsEnabled?: boolean
}): ProactiveContext {
  return {
    notificationsEnabled: over.notificationsEnabled ?? true,
    libraryLanguages: over.libraryLanguages,
    repos: { dailyWisdom: fakeRepo(over.corpus) },
    t: (k: string) => k,
  } as unknown as ProactiveContext
}

describe("daily_wisdom rule", () => {
  it("delivers a random fragment in the user's library language", async () => {
    const corpus = [frag("ru1", "ru"), frag("en1", "en")]
    const out = await dailyWisdomRule.detect(ctx({ corpus, libraryLanguages: ["en"] }), {} as never)
    expect(out).toHaveLength(1)
    expect(out[0].ruleDate).toBe("en1")
  })

  it("ignores the user's topics — draws from the whole corpus, not interest-scoped", async () => {
    // Many fragments across several topics; with no topic filter any of them
    // can be picked, and every pick is a valid en fragment.
    const corpus = [frag("en1", "en"), frag("en2", "en"), frag("en3", "en")]
    const ids = new Set(corpus.map((f) => f.id))
    for (let i = 0; i < 20; i++) {
      const out = await dailyWisdomRule.detect(
        ctx({ corpus, libraryLanguages: ["en"] }),
        {} as never
      )
      expect(out).toHaveLength(1)
      expect(ids.has(out[0].ruleDate)).toBe(true)
    }
  })

  it("skips the day rather than delivering a wrong-language fragment", async () => {
    const corpus = [frag("ru1", "ru")]
    const out = await dailyWisdomRule.detect(ctx({ corpus, libraryLanguages: ["en"] }), {} as never)
    expect(out).toEqual([])
  })

  it("allows any language when no library filter is set", async () => {
    const corpus = [frag("ru1", "ru")]
    const out = await dailyWisdomRule.detect(ctx({ corpus, libraryLanguages: [] }), {} as never)
    expect(out).toHaveLength(1)
    expect(out[0].ruleDate).toBe("ru1")
  })

  it("stays silent when daily engagement is off", async () => {
    const corpus = [frag("en1", "en")]
    const out = await dailyWisdomRule.detect(
      ctx({ corpus, libraryLanguages: ["en"], notificationsEnabled: false }),
      {} as never
    )
    expect(out).toEqual([])
  })
})

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

/** A fake daily_wisdom repo over a fixed corpus that honours the `language`
 *  filter exactly the way the SQL repo does. */
function fakeRepo(corpus: readonly DailyWisdom[]) {
  const inLang = (w: DailyWisdom, lang?: LanguageCode) => lang === undefined || w.language === lang
  return {
    async topicsWithWisdom(topicIds: readonly TopicId[], lang?: LanguageCode) {
      const set = new Set(topicIds)
      return [
        ...new Set(
          corpus.filter((w) => set.has(w.topicId) && inLang(w, lang)).map((w) => w.topicId)
        ),
      ]
    },
    async byTopic(topicId: TopicId, lang?: LanguageCode) {
      return corpus.filter((w) => w.topicId === topicId && inLang(w, lang))
    },
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
  interestTopicIds?: readonly TopicId[]
  notificationsEnabled?: boolean
}): ProactiveContext {
  return {
    notificationsEnabled: over.notificationsEnabled ?? true,
    interestTopicIds: over.interestTopicIds ?? (["topic_a"] as TopicId[]),
    libraryLanguages: over.libraryLanguages,
    repos: { dailyWisdom: fakeRepo(over.corpus) },
    t: (k: string) => k,
  } as unknown as ProactiveContext
}

describe("daily_wisdom language filter", () => {
  it("only delivers a fragment in the user's library language", async () => {
    const corpus = [frag("ru1", "ru"), frag("en1", "en")]
    const out = await dailyWisdomRule.detect(ctx({ corpus, libraryLanguages: ["en"] }), {} as never)
    expect(out).toHaveLength(1)
    expect(out[0].ruleDate).toBe("en1")
  })

  it("skips the day rather than delivering a wrong-language fragment", async () => {
    // Library is English but the only fragment for the topic is Russian.
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

  it("stays silent when daily engagement is off or no interests picked", async () => {
    const corpus = [frag("en1", "en")]
    expect(
      await dailyWisdomRule.detect(
        ctx({ corpus, libraryLanguages: ["en"], notificationsEnabled: false }),
        {} as never
      )
    ).toEqual([])
    expect(
      await dailyWisdomRule.detect(
        ctx({ corpus, libraryLanguages: ["en"], interestTopicIds: [] }),
        {} as never
      )
    ).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import type {
  ChatMessageId,
  ChatSessionId,
  LanguageCode,
  SourceId,
  TrackId,
} from "@lib/domain/core.js"
import type { Source } from "@lib/domain/source.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { ISourceRepository } from "@lib/domain/ports/sourceRepository.js"
import type { ProactiveStateEntry } from "@lib/domain/ports/proactiveStateRepository.js"
import type { AppRepositories } from "@shruti/repositories.js"
import type { ProactiveContext } from "../../types.js"
import { nextShlokaRule } from "../nextShloka.js"

const BG = "src_bg" as SourceId
const EN = "en" as LanguageCode
const RU = "ru" as LanguageCode

function stub<T extends object>(name: string, impl: Partial<T>): T {
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      throw new Error(`${name}.${String(prop)} is not exercised by this test`)
    },
  }) as T
}

function variant(trackId: TrackId, language: LanguageCode, title: string): TrackVariant {
  return {
    trackId,
    language,
    title,
    audios: [],
    audio: null,
    transcript: null,
    outline: null,
    description: null,
  }
}

function track(
  id: string,
  over: { tokens?: readonly string[]; variants?: readonly TrackVariant[] } = {}
): Track {
  const trackId = id as TrackId
  return {
    id: trackId,
    authorId: null,
    locationId: null,
    date: "2026-01-02",
    hidden: false,
    references: over.tokens ? [{ sourceId: BG, tokens: over.tokens }] : [],
    tagIds: [],
    topicIds: [],
    variants: over.variants ?? [variant(trackId, EN, `Lecture ${id}`)],
  }
}

const GITA: Source = {
  id: BG,
  names: new Map([
    [EN, { shortName: "BG", fullName: "Bhagavad-gītā" }],
    [RU, { shortName: "БГ", fullName: "Бхагавад-гита" }],
  ]),
}

function ctx(over: {
  corpus?: readonly Track[]
  sources?: readonly Source[]
  libraryLanguages?: readonly LanguageCode[]
  locale?: string
}): ProactiveContext {
  const byId = new Map((over.corpus ?? []).map((t) => [t.id, t]))
  return stub<ProactiveContext>("ctx", {
    locale: over.locale ?? "en",
    libraryLanguages: over.libraryLanguages ?? [],
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}(${params.ref ?? ""}|${params.title ?? ""})` : key,
    repos: stub<AppRepositories>("repos", {
      tracks: stub<ITrackRepository>("tracks", {
        getById: async (id) => byId.get(id) ?? null,
      }),
      sources: stub<ISourceRepository>("sources", {
        listAll: async () => over.sources ?? [GITA],
      }),
    }),
  })
}

function entry(ruleDate: string): ProactiveStateEntry {
  return {
    chatMessageId: "m-1" as ChatMessageId,
    sessionId: "s-1" as ChatSessionId,
    ruleKind: "next_shloka",
    ruleDate,
    prepState: "pending",
    preparedAt: null,
    bodyMd: "",
    visibleAt: null,
    notify: false,
    createdAt: 1_000,
    seenAt: null,
  }
}

describe("next_shloka — validate", () => {
  it("keeps a row whose suggested track is still published", async () => {
    const suggested = track("next", { tokens: ["2", "14"] })

    expect(await nextShlokaRule.validate(entry("next"), ctx({ corpus: [suggested] }))).toBe(true)
  })

  it("supersedes a row whose track the catalog dropped", async () => {
    expect(await nextShlokaRule.validate(entry("next"), ctx({ corpus: [] }))).toBe(false)
  })
})

describe("next_shloka — buildContent", () => {
  it("names the verse and the lecture, and carries a queue action", async () => {
    const suggested = track("next", { tokens: ["2", "14"] })

    const content = await nextShlokaRule.buildContent(entry("next"), ctx({ corpus: [suggested] }))

    expect(content?.bodyMd).toContain("BG 2.14")
    expect(content?.bodyMd).toContain("Lecture next")
    expect(content?.bodyMd).toContain("[action:queue_next_track|id=main]")
    expect(content?.actions).toEqual({
      main: { kind: "queue_next_track", id: "main", trackId: "next" },
    })
  })

  it("labels the verse in the library language, not the UI locale", async () => {
    const suggested = track("next", {
      tokens: ["2", "14"],
      variants: [
        variant("next" as TrackId, EN, "English lecture"),
        variant("next" as TrackId, RU, "Русская лекция"),
      ],
    })

    const content = await nextShlokaRule.buildContent(
      entry("next"),
      ctx({ corpus: [suggested], libraryLanguages: [RU], locale: "en" })
    )

    expect(content?.bodyMd).toContain("БГ 2.14")
    expect(content?.bodyMd).toContain("Русская лекция")
  })

  it("falls back to the raw source id when the source is unknown", async () => {
    const suggested = track("next", { tokens: ["2", "14"] })

    const content = await nextShlokaRule.buildContent(
      entry("next"),
      ctx({ corpus: [suggested], sources: [] })
    )

    expect(content?.bodyMd).toContain("src_bg 2.14")
  })

  it("stays silent when the track is gone", async () => {
    expect(await nextShlokaRule.buildContent(entry("next"), ctx({ corpus: [] }))).toBeNull()
  })

  it("stays silent when the track carries no reference", async () => {
    const content = await nextShlokaRule.buildContent(
      entry("next"),
      ctx({ corpus: [track("next")] })
    )

    expect(content).toBeNull()
  })

  it("stays silent when the track has no variant to render", async () => {
    const content = await nextShlokaRule.buildContent(
      entry("next"),
      ctx({ corpus: [track("next", { tokens: ["2", "14"], variants: [] })] })
    )

    expect(content).toBeNull()
  })

  it("uses the track's own variant when none is in the library languages", async () => {
    const suggested = track("next", {
      tokens: ["2", "14"],
      variants: [variant("next" as TrackId, EN, "English lecture")],
    })

    const content = await nextShlokaRule.buildContent(
      entry("next"),
      ctx({ corpus: [suggested], libraryLanguages: [RU] })
    )

    expect(content?.bodyMd).toContain("English lecture")
  })
})

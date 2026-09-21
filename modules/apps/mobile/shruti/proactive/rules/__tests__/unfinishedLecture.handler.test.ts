import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ChatMessageId,
  ChatSessionId,
  IsoDate,
  LanguageCode,
  TrackId,
} from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type {
  CreateProactiveMessageInput,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import type { ProactiveContext, ProactiveRuleHandler } from "../../types.js"
import { resolveRules } from "../../registry.js"
import "../unfinishedLecture.js"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const NOW = new Date(2026, 5, 1, 12, 0, 0, 0).getTime()

function ruleHandler(): ProactiveRuleHandler {
  const rule = resolveRules().find((r) => r.config.id === "unfinished_lecture")
  if (!rule) throw new Error("unfinished_lecture is not registered")
  return rule.handler
}

function track(id: string, over: Partial<Track> = {}, titles: Record<string, string> = {}): Track {
  const languages = Object.keys(titles).length > 0 ? Object.keys(titles) : ["en"]
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "2026-01-01" as IsoDate,
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: languages.map((language) => ({
      language: language as LanguageCode,
      title: titles[language] ?? `title ${id}`,
      audio: { duration: HOUR_MS },
    })),
    ...over,
  } as unknown as Track
}

interface Stubs {
  readonly created: CreateProactiveMessageInput[]
  readonly deletedSessions: ChatSessionId[]
  readonly ctx: ProactiveContext
}

function context(over: {
  tracks?: readonly Track[]
  progress?: readonly { trackId: TrackId; positionSec: number }[]
  recent?: readonly Partial<ProactiveStateEntry>[]
  existing?: boolean
  createReturnsNull?: boolean
  libraryLanguages?: readonly LanguageCode[]
  locale?: string
  nowMs?: number
}): Stubs {
  const corpus = new Map((over.tracks ?? []).map((t) => [t.id, t]))
  const created: CreateProactiveMessageInput[] = []
  const deletedSessions: ChatSessionId[] = []
  const ctx = {
    nowMs: over.nowMs ?? NOW,
    locale: over.locale ?? "en",
    libraryLanguages: over.libraryLanguages ?? (["en"] as LanguageCode[]),
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    repos: {
      proactiveState: {
        listRecentByRule: async () => over.recent ?? [],
        findByRuleAndDate: async () =>
          over.existing ? ({ chatMessageId: "old" } as ProactiveStateEntry) : null,
        create: async (input: CreateProactiveMessageInput) => {
          created.push(input)
          return over.createReturnsNull ? null : (input as unknown as ProactiveStateEntry)
        },
      },
      listeningSessions: {
        listRecentTracksWithProgress: async () => over.progress ?? [],
      },
      tracks: {
        getByIds: async (ids: readonly TrackId[]) =>
          new Map(ids.filter((id) => corpus.has(id)).map((id) => [id, corpus.get(id)!])),
        getById: async (id: TrackId) => corpus.get(id) ?? null,
      },
      chatSessions: {
        create: async (input: { id: ChatSessionId; title: string | null }) => input,
        delete: async (id: ChatSessionId) => {
          deletedSessions.push(id)
        },
      },
    },
  } as unknown as ProactiveContext
  return { created, deletedSessions, ctx }
}

function entry(over: Partial<ProactiveStateEntry> = {}): ProactiveStateEntry {
  return {
    chatMessageId: "msg-1" as ChatMessageId,
    sessionId: "sess-1" as ChatSessionId,
    ruleKind: "unfinished_lecture",
    ruleDate: "track_a",
    prepState: "ready",
    preparedAt: NOW,
    bodyMd: "Come back to «A lecture»\n\n[action:queue_next_track|id=main]",
    visibleAt: Math.floor((NOW + DAY_MS) / 1000),
    notify: true,
    createdAt: NOW,
    seenAt: null,
    ...over,
  }
}

describe("unfinished_lecture — detection on app pause", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("mints a row a day out for a half-listened lecture", async () => {
    const t = track("track_a")
    const { created, ctx } = context({
      tracks: [t],
      progress: [{ trackId: t.id, positionSec: 1800 }],
    })
    await ruleHandler().onAppPause!(ctx)

    expect(created).toHaveLength(1)
    expect(created[0].ruleKind).toBe("unfinished_lecture")
    expect(created[0].ruleDate).toBe("track_a")
    expect(created[0].notify).toBe(true)
    expect(created[0].prepState).toBe("pending")
    expect(created[0].visibleAt).toBe(Math.floor((NOW + DAY_MS) / 1000))
  })

  it("stays silent while the 3-day cooldown is still running, and fires once past it", async () => {
    const t = track("track_a")
    const progress = [{ trackId: t.id, positionSec: 1800 }]

    const justInside = context({
      tracks: [t],
      progress,
      recent: [entry({ createdAt: NOW - 3 * DAY_MS + 1000 })],
    })
    await ruleHandler().onAppPause!(justInside.ctx)
    expect(justInside.created).toHaveLength(0)

    const justOutside = context({
      tracks: [t],
      progress,
      recent: [entry({ createdAt: NOW - 3 * DAY_MS })],
    })
    await ruleHandler().onAppPause!(justOutside.ctx)
    expect(justOutside.created).toHaveLength(1)
  })

  it("stays silent when nothing was listened to at all", async () => {
    const { created, ctx } = context({ tracks: [], progress: [] })
    await ruleHandler().onAppPause!(ctx)
    expect(created).toHaveLength(0)
  })

  it("stays silent when every recent lecture is finished or barely sampled", async () => {
    const done = track("track_a")
    const barely = track("track_b")
    const { created, ctx } = context({
      tracks: [done, barely],
      progress: [
        { trackId: done.id, positionSec: 3500 },
        { trackId: barely.id, positionSec: 60 },
      ],
    })
    await ruleHandler().onAppPause!(ctx)
    expect(created).toHaveLength(0)
  })

  it("stays silent when the catalog has no title for the lecture", async () => {
    const t = track("track_a", {}, { en: "" })
    const { created, ctx } = context({
      tracks: [t],
      progress: [{ trackId: t.id, positionSec: 1800 }],
    })
    await ruleHandler().onAppPause!(ctx)
    expect(created).toHaveLength(0)
  })

  it("stays silent when a row for that same lecture already exists", async () => {
    const t = track("track_a")
    const { created, ctx } = context({
      tracks: [t],
      progress: [{ trackId: t.id, positionSec: 1800 }],
      existing: true,
    })
    await ruleHandler().onAppPause!(ctx)
    expect(created).toHaveLength(0)
  })

  it("deletes the freshly-minted session when the row loses the insert race", async () => {
    const t = track("track_a")
    const { created, deletedSessions, ctx } = context({
      tracks: [t],
      progress: [{ trackId: t.id, positionSec: 1800 }],
      createReturnsNull: true,
    })
    await ruleHandler().onAppPause!(ctx)

    expect(created).toHaveLength(1)
    expect(deletedSessions).toEqual([created[0].sessionId])
  })

  it("never fires from a foreground tick", async () => {
    const { ctx } = context({})
    expect(await ruleHandler().detect(ctx, { id: "unfinished_lecture" } as never)).toEqual([])
  })
})

describe("unfinished_lecture — staying relevant", () => {
  it("keeps the nudge while the lecture is still unfinished and in the recent window", async () => {
    const t = track("track_a")
    const { ctx } = context({
      tracks: [t],
      progress: [{ trackId: t.id, positionSec: 1800 }],
    })
    expect(await ruleHandler().validate(entry(), ctx)).toBe(true)
  })

  it("drops the nudge once the lecture was listened past the completion threshold", async () => {
    const t = track("track_a")
    const { ctx } = context({
      tracks: [t],
      progress: [{ trackId: t.id, positionSec: 3500 }],
    })
    expect(await ruleHandler().validate(entry(), ctx)).toBe(false)
  })

  it("drops the nudge when the lecture fell out of the recent window", async () => {
    const t = track("track_a")
    const other = track("track_b")
    const { ctx } = context({
      tracks: [t, other],
      progress: [{ trackId: other.id, positionSec: 100 }],
    })
    expect(await ruleHandler().validate(entry(), ctx)).toBe(false)
  })

  it("drops the nudge when the lecture was pulled from the catalog", async () => {
    const hidden = track("track_a", { hidden: true })
    const { ctx } = context({
      tracks: [hidden],
      progress: [{ trackId: hidden.id, positionSec: 1800 }],
    })
    expect(await ruleHandler().validate(entry(), ctx)).toBe(false)

    const gone = context({ tracks: [], progress: [] })
    expect(await ruleHandler().validate(entry(), gone.ctx)).toBe(false)
  })
})

describe("unfinished_lecture — what gets pushed and shown", () => {
  it("pushes the lecture name with the action marker stripped, at the visible moment", () => {
    const pushes = ruleHandler().collectNotifications!(
      entry(),
      {} as ProactiveContext,
      "background"
    )
    expect(pushes).toHaveLength(1)
    expect(pushes[0].body).toBe("Come back to «A lecture»")
    expect(pushes[0].fireAtMs).toBe(entry().visibleAt! * 1000)
    expect(pushes[0].kind).toBe("unfinished_lecture")
    expect(pushes[0].extra).toEqual({ chatSessionId: "sess-1", chatMessageId: "msg-1" })
  })

  it("pushes nothing for a row that is silent, undated, or has no body yet", () => {
    const handler = ruleHandler()
    const ctx = {} as ProactiveContext
    expect(handler.collectNotifications!(entry({ notify: false }), ctx, "background")).toEqual([])
    expect(handler.collectNotifications!(entry({ visibleAt: null }), ctx, "background")).toEqual([])
    expect(handler.collectNotifications!(entry({ bodyMd: "" }), ctx, "background")).toEqual([])
    // A body that is nothing but the marker leaves no readable line.
    expect(
      handler.collectNotifications!(
        entry({ bodyMd: "[action:queue_next_track|id=main]" }),
        ctx,
        "background"
      )
    ).toEqual([])
  })

  it("builds a body that names the lecture and queues it behind one tap", async () => {
    const t = track("track_a", {}, { en: "Bhagavad-gita 2.13" })
    const { ctx } = context({ tracks: [t] })
    const content = await ruleHandler().buildContent(entry(), ctx)

    expect(content!.bodyMd).toContain('"title":"Bhagavad-gita 2.13"')
    expect(content!.bodyMd).toContain("[action:queue_next_track|id=main]")
    expect(content!.actions).toEqual({
      main: { kind: "queue_next_track", id: "main", trackId: "track_a" },
    })
  })

  it("names the lecture in the library language, not the interface one", async () => {
    const t = track("track_a", {}, { en: "English title", ru: "Русское название" })
    const { ctx } = context({
      tracks: [t],
      libraryLanguages: ["ru"] as LanguageCode[],
      locale: "en",
    })
    const content = await ruleHandler().buildContent(entry(), ctx)
    expect(content!.bodyMd).toContain("Русское название")
  })

  it("builds nothing for a lecture that left the catalog", async () => {
    const { ctx } = context({ tracks: [] })
    expect(await ruleHandler().buildContent(entry(), ctx)).toBeNull()
  })
})

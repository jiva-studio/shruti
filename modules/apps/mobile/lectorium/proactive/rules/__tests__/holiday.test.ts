import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { HolidayEntry, ProactiveRuleConfig } from "@lib/domain/config.js"
import type { ProactiveStateEntry } from "@lib/domain/ports/proactiveStateRepository.js"
import type { ProactiveContext, ProactiveRuleHandler } from "../../types.js"

const remote = vi.hoisted(() => ({
  holidays: [] as HolidayEntry[],
  throws: false,
  reads: 0,
}))

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    storagePublicUrl: { get: (path: string) => `https://cdn.test/${path}` },
    appConfig: { publicRemoteConfigPath: "config.json" },
    remoteJson: {
      getJson: async () => {
        remote.reads++
        if (remote.throws) throw new Error("offline")
        return { proactive: { calendars: { holidays: remote.holidays } } }
      },
    },
  }),
}))

import { resolveRules } from "../../registry.js"
import "../holiday.js"

function ruleHandler(): ProactiveRuleHandler {
  const rule = resolveRules().find((r) => r.config.id === "holiday")
  if (!rule) throw new Error("holiday is not registered")
  return rule.handler
}

function holiday(id: string, date: string, name: Record<string, string>): HolidayEntry {
  return { id, date, name } as HolidayEntry
}

function config(over: Partial<ProactiveRuleConfig> = {}): ProactiveRuleConfig {
  return { id: "holiday", enabled: true, ...over } as ProactiveRuleConfig
}

function context(localDate: string, locale = "en"): ProactiveContext {
  return {
    localDate,
    locale,
    nowMs: new Date(`${localDate}T12:00:00`).getTime(),
    t: (key: string) => key,
    proactiveChat: { run: async () => ({ bodyMd: "curated playlist" }) },
  } as unknown as ProactiveContext
}

function entry(over: Partial<ProactiveStateEntry> = {}): ProactiveStateEntry {
  return {
    chatMessageId: "msg-1" as ChatMessageId,
    sessionId: "sess-1" as ChatSessionId,
    ruleKind: "holiday",
    ruleDate: "2026-08-16",
    prepState: "ready",
    preparedAt: 0,
    bodyMd: "Janmashtami is here [^1]",
    visibleAt: Math.floor(new Date(2026, 7, 16, 8, 0, 0, 0).getTime() / 1000),
    notify: true,
    createdAt: 0,
    seenAt: null,
    ...over,
  }
}

/** The calendar is cached for 60 s at module level, keyed on the wall clock,
 *  so the fake clock only ever moves forward. */
let clock = new Date(2026, 7, 14, 12, 0, 0, 0).getTime()

function expireCalendarCache(): void {
  clock += 120_000
  vi.setSystemTime(clock)
}

describe("holiday — which ones it picks up", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    remote.holidays = []
    remote.throws = false
    remote.reads = 0
    expireCalendarCache()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("picks up a holiday inside the two-day prep window and pins it to 08:00 local", async () => {
    remote.holidays = [holiday("janmashtami", "2026-08-16", { en: "Janmashtami" })]
    const out = await ruleHandler().detect(context("2026-08-14"), config())

    expect(out).toHaveLength(1)
    expect(out[0].ruleDate).toBe("2026-08-16")
    expect(out[0].notify).toBe(true)
    expect(out[0].visibleAt).toBe(Math.floor(new Date(2026, 7, 16, 8, 0, 0, 0).getTime() / 1000))
    expect(out[0].templateContext).toMatchObject({
      holiday_id: "janmashtami",
      holiday_name: "Janmashtami",
      holiday_date: "2026-08-16",
    })
  })

  it("picks up today's holiday and skips one that already went by", async () => {
    remote.holidays = [
      holiday("today", "2026-08-14", { en: "Today" }),
      holiday("gone", "2026-08-13", { en: "Yesterday" }),
    ]
    const out = await ruleHandler().detect(context("2026-08-14"), config())
    expect(out.map((r) => r.ruleDate)).toEqual(["2026-08-14"])
  })

  it("leaves a holiday past the prep window for a later tick", async () => {
    remote.holidays = [holiday("far", "2026-08-17", { en: "Far" })]
    expect(await ruleHandler().detect(context("2026-08-14"), config())).toEqual([])

    expireCalendarCache()
    const wider = await ruleHandler().detect(
      context("2026-08-14"),
      config({ prep_window_hours: 96 })
    )
    expect(wider).toHaveLength(1)
  })

  it("emits one result per holiday when several fall in the window", async () => {
    remote.holidays = [
      holiday("a", "2026-08-15", { en: "A" }),
      holiday("b", "2026-08-16", { en: "B" }),
    ]
    const out = await ruleHandler().detect(context("2026-08-14"), config())
    expect(out.map((r) => r.ruleDate)).toEqual(["2026-08-15", "2026-08-16"])
  })

  it("names the holiday in the user's language, falling back to English then the id", async () => {
    remote.holidays = [
      holiday("translated", "2026-08-15", { en: "Janmashtami", ru: "Джанмаштами" }),
      holiday("english-only", "2026-08-16", { en: "Radhashtami" }),
      holiday("unnamed", "2026-08-16", {}),
    ]
    const out = await ruleHandler().detect(context("2026-08-14", "ru"), config())
    expect(out.map((r) => r.sessionTitleOverride)).toEqual([
      "Джанмаштами",
      "Radhashtami",
      "unnamed",
    ])
  })

  it("emits nothing when the published calendar is empty or unreachable", async () => {
    expect(await ruleHandler().detect(context("2026-08-14"), config())).toEqual([])

    expireCalendarCache()
    remote.throws = true
    expect(await ruleHandler().detect(context("2026-08-14"), config())).toEqual([])
  })

  it("reads the published calendar once per tick, not once per call", async () => {
    remote.holidays = [holiday("a", "2026-08-15", { en: "A" })]
    remote.reads = 0

    await ruleHandler().detect(context("2026-08-14"), config())
    await ruleHandler().validate(entry({ ruleDate: "2026-08-15" }), context("2026-08-14"))
    await ruleHandler().buildContent(entry({ ruleDate: "2026-08-15" }), context("2026-08-14"))

    expect(remote.reads).toBe(1)
  })

  it("retries a failed calendar read instead of caching the failure", async () => {
    remote.throws = true
    remote.reads = 0
    await ruleHandler().detect(context("2026-08-14"), config())
    await ruleHandler().detect(context("2026-08-14"), config())
    expect(remote.reads).toBe(2)
  })
})

describe("holiday — staying relevant and what gets pushed", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    remote.holidays = [holiday("janmashtami", "2026-08-16", { en: "Janmashtami" })]
    remote.throws = false
    expireCalendarCache()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps a row whose holiday is still on the calendar", async () => {
    expect(await ruleHandler().validate(entry(), context("2026-08-14"))).toBe(true)
  })

  it("drops a row whose holiday was taken off the calendar", async () => {
    remote.holidays = []
    expireCalendarCache()
    expect(await ruleHandler().validate(entry(), context("2026-08-14"))).toBe(false)
  })

  it("pushes the body with the card marker stripped, at 08:00 on the day", () => {
    const pushes = ruleHandler().collectNotifications!(
      entry(),
      {} as ProactiveContext,
      "foreground"
    )
    expect(pushes).toHaveLength(1)
    expect(pushes[0].body).toBe("Janmashtami is here")
    expect(pushes[0].kind).toBe("holiday")
    expect(pushes[0].fireAtMs).toBe(entry().visibleAt! * 1000)
  })

  it("pushes nothing for a silent, undated or bodiless row", () => {
    const handler = ruleHandler()
    const ctx = {} as ProactiveContext
    expect(handler.collectNotifications!(entry({ notify: false }), ctx, "foreground")).toEqual([])
    expect(handler.collectNotifications!(entry({ visibleAt: null }), ctx, "foreground")).toEqual([])
    expect(handler.collectNotifications!(entry({ bodyMd: "[^1]" }), ctx, "foreground")).toEqual([])
  })

  it("asks the backend to curate the day, telling it how far off the holiday is", async () => {
    const run = vi.fn<
      (request: Record<string, unknown>, locale: string) => Promise<{ bodyMd: string }>
    >(async () => ({ bodyMd: "curated playlist" }))
    const ctx = {
      ...context("2026-08-14"),
      proactiveChat: { run },
    } as unknown as ProactiveContext

    const content = await ruleHandler().buildContent(entry(), ctx)
    expect(content).toEqual({ bodyMd: "curated playlist" })
    expect(run.mock.calls[0][0]).toMatchObject({
      ruleKind: "holiday",
      ruleDate: "2026-08-16",
      ruleContext: expect.objectContaining({ holiday_name: "Janmashtami", days_until: 2 }),
    })
  })

  it("builds nothing for a holiday that left the calendar", async () => {
    remote.holidays = []
    expireCalendarCache()
    expect(await ruleHandler().buildContent(entry(), context("2026-08-14"))).toBeNull()
  })
})

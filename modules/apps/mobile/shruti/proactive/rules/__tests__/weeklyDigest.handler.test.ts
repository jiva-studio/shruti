import { describe, expect, it } from "vitest"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ProactiveRuleConfig } from "@lib/domain/config.js"
import type { ProactiveStateEntry } from "@lib/domain/ports/proactiveStateRepository.js"
import type { ProactiveContext, ProactiveRuleHandler } from "../../types.js"
import { resolveRules } from "../../registry.js"
import "../weeklyDigest.js"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
// 2026-06-08 is a Monday; the digest targets 09:00 local that day.
const MONDAY_9AM = new Date(2026, 5, 8, 9, 0, 0, 0).getTime()

function ruleHandler(): ProactiveRuleHandler {
  const rule = resolveRules().find((r) => r.config.id === "weekly_digest")
  if (!rule) throw new Error("weekly_digest is not registered")
  return rule.handler
}

function config(over: Partial<ProactiveRuleConfig> = {}): ProactiveRuleConfig {
  return { id: "weekly_digest", enabled: true, ...over } as ProactiveRuleConfig
}

function context(nowMs: number, locale = "en"): ProactiveContext {
  return {
    nowMs,
    locale,
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  } as unknown as ProactiveContext
}

function entry(over: Partial<ProactiveStateEntry> = {}): ProactiveStateEntry {
  return {
    chatMessageId: "msg-1" as ChatMessageId,
    sessionId: "sess-1" as ChatSessionId,
    ruleKind: "weekly_digest",
    ruleDate: "2026-06-08",
    prepState: "ready",
    preparedAt: MONDAY_9AM,
    bodyMd: `Here is your week\n\n[digest:${MONDAY_9AM}-${MONDAY_9AM}]`,
    visibleAt: Math.floor(MONDAY_9AM / 1000),
    notify: true,
    createdAt: MONDAY_9AM - DAY_MS,
    seenAt: null,
    ...over,
  }
}

describe("weekly_digest — when it decides to fire", () => {
  it("waits while the Monday morning is further out than the prep window", async () => {
    const justOutside = MONDAY_9AM - 12 * HOUR_MS - 1000
    expect(await ruleHandler().detect(context(justOutside), config())).toEqual([])
  })

  it("fires as soon as the prep window opens", async () => {
    const justInside = MONDAY_9AM - 12 * HOUR_MS + 1000
    const out = await ruleHandler().detect(context(justInside), config())
    expect(out).toHaveLength(1)
    expect(out[0].ruleDate).toBe("2026-06-08")
    expect(out[0].visibleAt).toBe(Math.floor(MONDAY_9AM / 1000))
    expect(out[0].notify).toBe(true)
  })

  it("honours a prep window widened by config", async () => {
    const twoDaysOut = MONDAY_9AM - 2 * 24 * HOUR_MS
    expect(await ruleHandler().detect(context(twoDaysOut), config())).toEqual([])
    const wide = await ruleHandler().detect(context(twoDaysOut), config({ prep_window_hours: 72 }))
    expect(wide).toHaveLength(1)
  })

  // The grace hour: a user whose first look of the day is at 09:05 still gets
  // the digest. Past it, the moment has gone and there is no backfill.
  it("still emits at the notify hour and through the grace that follows", async () => {
    expect(await ruleHandler().detect(context(MONDAY_9AM), config())).toHaveLength(1)
    expect(await ruleHandler().detect(context(MONDAY_9AM + 30 * 60_000), config())).toHaveLength(1)
    expect(await ruleHandler().detect(context(MONDAY_9AM + HOUR_MS), config())).toHaveLength(1)
  })

  it("does not backfill once the grace hour has gone", async () => {
    expect(await ruleHandler().detect(context(MONDAY_9AM + HOUR_MS + 60_000), config())).toEqual([])
    expect(await ruleHandler().detect(context(MONDAY_9AM + 10 * HOUR_MS), config())).toEqual([])
  })

  it("labels the finished week, not the one still running", async () => {
    const out = await ruleHandler().detect(context(MONDAY_9AM - HOUR_MS), config())
    // The week recapped is Mon 2026-06-01 through Sun 2026-06-07.
    expect(out[0].templateContext.week_label).toBe("Jun 1–7")
  })

  it("spells a week that spans two months with both months", async () => {
    // 2026-11-02 is a Monday, so the finished week is Oct 26 – Nov 1.
    const monday = new Date(2026, 10, 2, 9, 0, 0, 0).getTime()
    const out = await ruleHandler().detect(context(monday - HOUR_MS), config())
    expect(out[0].templateContext.week_label).toBe("Oct 26 – Nov 1")
  })

  it("writes the week label in the user's language", async () => {
    const sameMonth = await ruleHandler().detect(context(MONDAY_9AM - HOUR_MS, "ru"), config())
    expect(sameMonth[0].templateContext.week_label).toBe("1–7")

    const monday = new Date(2026, 10, 2, 9, 0, 0, 0).getTime()
    const crossMonth = await ruleHandler().detect(context(monday - HOUR_MS, "ru"), config())
    expect(crossMonth[0].templateContext.week_label).toBe("26.10–1.11")
  })

  it("recaps even a week the user listened to nothing in", async () => {
    expect(await ruleHandler().validate(entry(), context(MONDAY_9AM))).toBe(true)
  })
})

describe("weekly_digest — what gets pushed and shown", () => {
  it("pushes the intro line with the recap marker stripped", () => {
    const pushes = ruleHandler().collectNotifications!(
      entry(),
      {} as ProactiveContext,
      "foreground"
    )
    expect(pushes).toHaveLength(1)
    expect(pushes[0].body).toBe("Here is your week")
    expect(pushes[0].fireAtMs).toBe(MONDAY_9AM)
    expect(pushes[0].kind).toBe("weekly_digest")
  })

  it("pushes nothing for a silent, undated or bodiless row", () => {
    const handler = ruleHandler()
    const ctx = {} as ProactiveContext
    expect(handler.collectNotifications!(entry({ notify: false }), ctx, "foreground")).toEqual([])
    expect(handler.collectNotifications!(entry({ visibleAt: null }), ctx, "foreground")).toEqual([])
    expect(
      handler.collectNotifications!(
        entry({ bodyMd: `[digest:${MONDAY_9AM}-${MONDAY_9AM}]` }),
        ctx,
        "foreground"
      )
    ).toEqual([])
  })

  it("marks the seven days ending at the digest's Monday", async () => {
    const content = await ruleHandler().buildContent(entry(), context(MONDAY_9AM))
    const mondayMidnight = new Date(2026, 5, 8, 0, 0, 0, 0).getTime()
    expect(content!.bodyMd).toContain(`[digest:${mondayMidnight - 7 * DAY_MS}-${mondayMidnight}]`)
    expect(content!.bodyMd.startsWith("chat.weeklyDigestIntro")).toBe(true)
  })
})

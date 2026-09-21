import { describe, expect, it } from "vitest"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type {
  CreateProactiveMessageInput,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import type { ProactiveContext, ProactiveRuleHandler } from "../../types.js"
import { resolveRules } from "../../registry.js"
import { STAGE_BODY_KEY } from "../inactivity.js"

const DAY_MS = 86_400_000
const NOW = new Date(2026, 5, 1, 12, 0, 0, 0).getTime()
const FIRST_STAGE_SEC = Math.floor((NOW + 3 * DAY_MS) / 1000)

function ruleHandler(): ProactiveRuleHandler {
  const rule = resolveRules().find((r) => r.config.id === "inactivity")
  if (!rule) throw new Error("inactivity is not registered")
  return rule.handler
}

function entry(over: Partial<ProactiveStateEntry> = {}): ProactiveStateEntry {
  return {
    chatMessageId: "msg-1" as ChatMessageId,
    sessionId: "sess-1" as ChatSessionId,
    ruleKind: "inactivity",
    ruleDate: "ladder",
    prepState: "ready",
    preparedAt: NOW,
    bodyMd: "Come back",
    visibleAt: FIRST_STAGE_SEC,
    notify: false,
    createdAt: NOW,
    seenAt: null,
    ...over,
  }
}

interface Stubs {
  readonly created: CreateProactiveMessageInput[]
  readonly rearmed: { id: ChatMessageId; visibleAtSec: number }[]
  readonly deletedSessions: ChatSessionId[]
  readonly ctx: ProactiveContext
}

function context(over: {
  existing?: ProactiveStateEntry | null
  createReturnsNull?: boolean
  nowMs?: number
}): Stubs {
  const created: CreateProactiveMessageInput[] = []
  const rearmed: { id: ChatMessageId; visibleAtSec: number }[] = []
  const deletedSessions: ChatSessionId[] = []
  const ctx = {
    nowMs: over.nowMs ?? NOW,
    locale: "en",
    t: (key: string) => key,
    repos: {
      proactiveState: {
        findByRuleAndDate: async () => over.existing ?? null,
        rearm: async (id: ChatMessageId, visibleAtSec: number) => {
          rearmed.push({ id, visibleAtSec })
        },
        create: async (input: CreateProactiveMessageInput) => {
          created.push(input)
          return over.createReturnsNull ? null : (input as unknown as ProactiveStateEntry)
        },
      },
      chatSessions: {
        create: async (input: { id: ChatSessionId; title: string | null }) => input,
        delete: async (id: ChatSessionId) => {
          deletedSessions.push(id)
        },
      },
    },
  } as unknown as ProactiveContext
  return { created, rearmed, deletedSessions, ctx }
}

describe("inactivity — arming the ladder", () => {
  it("creates the single come-back row anchored three days out", async () => {
    const { created, ctx } = context({ existing: null })
    await ruleHandler().onAppPause!(ctx)

    expect(created).toHaveLength(1)
    expect(created[0].ruleDate).toBe("ladder")
    expect(created[0].visibleAt).toBe(FIRST_STAGE_SEC)
    expect(created[0].prepState).toBe("ready")
    // The rule schedules its own per-stage alarms; the generic push path
    // must not arm a sixth one at `visible_at`.
    expect(created[0].notify).toBe(false)
    expect(created[0].content).toBe("chat.proactiveInactivityWelcomeBody")
  })

  it("re-anchors the existing row instead of minting a second one", async () => {
    const stale = entry({ visibleAt: FIRST_STAGE_SEC - (5 * DAY_MS) / 1000 })
    const { created, rearmed, ctx } = context({ existing: stale })
    await ruleHandler().onAppPause!(ctx)

    expect(created).toHaveLength(0)
    expect(rearmed).toEqual([{ id: "msg-1", visibleAtSec: FIRST_STAGE_SEC }])
  })

  it("leaves the ladder alone on a rapid background/foreground flip", async () => {
    const justInside = entry({ visibleAt: FIRST_STAGE_SEC - 3599 })
    const quiet = context({ existing: justInside })
    await ruleHandler().onAppPause!(quiet.ctx)
    expect(quiet.rearmed).toHaveLength(0)

    const justOutside = entry({ visibleAt: FIRST_STAGE_SEC - 3600 })
    const moved = context({ existing: justOutside })
    await ruleHandler().onAppPause!(moved.ctx)
    expect(moved.rearmed).toHaveLength(1)
  })

  it("re-anchors a row that carries no moment at all", async () => {
    const { rearmed, ctx } = context({ existing: entry({ visibleAt: null }) })
    await ruleHandler().onAppPause!(ctx)
    expect(rearmed).toEqual([{ id: "msg-1", visibleAtSec: FIRST_STAGE_SEC }])
  })

  it("drops the orphan session when the row loses the insert race", async () => {
    const { created, deletedSessions, ctx } = context({ existing: null, createReturnsNull: true })
    await ruleHandler().onAppPause!(ctx)
    expect(deletedSessions).toEqual([created[0].sessionId])
  })

  it("never arms from a foreground tick", async () => {
    const { ctx } = context({})
    expect(await ruleHandler().detect(ctx, { id: "inactivity" } as never)).toEqual([])
  })
})

describe("inactivity — the push ladder", () => {
  const ctx = { t: (key: string) => key } as unknown as ProactiveContext

  it("lays out five escalating stages from the moment the user left", () => {
    const pushes = ruleHandler().collectNotifications!(entry(), ctx, "background")
    const background = FIRST_STAGE_SEC * 1000 - 3 * DAY_MS

    expect(pushes.map((p) => (p.fireAtMs - background) / DAY_MS)).toEqual([3, 7, 14, 30, 60])
    expect(pushes.map((p) => p.body)).toEqual([3, 7, 14, 30, 60].map((d) => STAGE_BODY_KEY[d]))
    expect(new Set(pushes.map((p) => p.id)).size).toBe(5)
    expect(pushes[0].extra).toEqual({ chatSessionId: "sess-1", chatMessageId: "msg-1" })
  })

  it("arms nothing while the user is here", () => {
    expect(ruleHandler().collectNotifications!(entry(), ctx, "foreground")).toEqual([])
  })

  it("arms nothing for a row with no anchor", () => {
    expect(
      ruleHandler().collectNotifications!(entry({ visibleAt: null }), ctx, "background")
    ).toEqual([])
  })

  it("keeps the row on a foreground pass so its session is reused", async () => {
    expect(await ruleHandler().validate(entry(), ctx)).toBe(true)
  })

  it("rewrites the same copy on a refresh instead of blanking the row", async () => {
    const content = await ruleHandler().buildContent(entry(), ctx)
    expect(content).toEqual({ bodyMd: "chat.proactiveInactivityWelcomeBody" })
  })
})

import { describe, expect, it, vi } from "vitest"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ProactiveRuleConfig } from "@lib/domain/config.js"
import type {
  IProactiveStateRepository,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import { createProactivePrep } from "../prepProactiveRow.js"
import type {
  ProactiveContext,
  ProactiveEvent,
  ProactiveRuleHandler,
  ResolvedProactiveRule,
} from "../types.js"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function entry(over: Partial<ProactiveStateEntry> = {}): ProactiveStateEntry {
  return {
    chatMessageId: "msg-1" as ChatMessageId,
    sessionId: "sess-1" as ChatSessionId,
    ruleKind: "holiday",
    ruleDate: "2026-06-01",
    prepState: "pending",
    preparedAt: null,
    bodyMd: "",
    visibleAt: null,
    notify: false,
    createdAt: NOW,
    seenAt: null,
    ...over,
  }
}

function rule(handler: Partial<ProactiveRuleHandler>, config: Partial<ProactiveRuleConfig> = {}) {
  return {
    config: { id: "holiday", refresh_if_older_than_hours: 24, cooldown_hours: 24, ...config },
    handler: {
      id: "holiday",
      detect: async () => [],
      validate: async () => true,
      buildContent: async () => ({ bodyMd: "Body" }),
      ...handler,
    },
  } as ResolvedProactiveRule
}

function harness() {
  const events: ProactiveEvent[] = []
  const repo = {
    listRecentByRule: vi.fn(async () => []),
    updatePrepState: vi.fn(async () => undefined),
    updateContent: vi.fn(async () => undefined),
  } as unknown as IProactiveStateRepository & {
    listRecentByRule: ReturnType<typeof vi.fn>
    updatePrepState: ReturnType<typeof vi.fn>
    updateContent: ReturnType<typeof vi.fn>
  }
  const touch = vi.fn(async () => undefined)
  const ctx = {
    nowMs: NOW,
    repos: { tracks: { getByIds: async () => new Map() }, chatSessions: { touch } },
  } as unknown as ProactiveContext
  const prep = createProactivePrep({ emit: (e) => events.push(e) })
  return { events, repo, touch, ctx, prep }
}

describe("createProactivePrep — cooldown", () => {
  it("does not ask the repository when the rule has no cooldown", async () => {
    const h = harness()
    expect(await h.prep.isOnCooldown(rule({}, { cooldown_hours: 0 }), NOW, h.repo)).toBe(false)
    expect(h.repo.listRecentByRule).not.toHaveBeenCalled()
  })

  it("cools down after a recent live instance", async () => {
    const h = harness()
    h.repo.listRecentByRule.mockResolvedValueOnce([{ prepState: "ready", createdAt: NOW - HOUR }])
    expect(await h.prep.isOnCooldown(rule({}), NOW, h.repo)).toBe(true)
  })
})

describe("createProactivePrep — re-validation", () => {
  it("supersedes a row whose rule no longer holds", async () => {
    const h = harness()
    const kept = await h.prep.reValidateRow(
      entry(),
      rule({ validate: async () => false }),
      h.ctx,
      h.repo
    )
    expect(kept).toBe(false)
    expect(h.repo.updatePrepState).toHaveBeenCalledWith("msg-1", "superseded")
  })

  it("keeps a row whose validator threw", async () => {
    const h = harness()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const kept = await h.prep.reValidateRow(
      entry(),
      rule({
        validate: async () => {
          throw new Error("flaky")
        },
      }),
      h.ctx,
      h.repo
    )
    expect(kept).toBe(true)
    expect(h.repo.updatePrepState).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("createProactivePrep — building the body", () => {
  it("leaves a fresh ready row alone", async () => {
    const h = harness()
    const build = vi.fn(async () => ({ bodyMd: "x" }))
    await h.prep.prepIfStale(
      entry({ prepState: "ready", preparedAt: NOW - HOUR }),
      rule({ buildContent: build }),
      h.ctx,
      h.repo
    )
    expect(build).not.toHaveBeenCalled()
  })

  it("builds a pending row, marks it ready, bumps its session and announces it", async () => {
    const h = harness()
    await h.prep.prepIfStale(entry(), rule({}), h.ctx, h.repo)

    expect(h.repo.updateContent).toHaveBeenCalledWith("msg-1", "Body", {}, undefined)
    expect(h.repo.updatePrepState).toHaveBeenCalledWith("msg-1", "ready", NOW)
    expect(h.touch).toHaveBeenCalledWith("sess-1", NOW)
    expect(h.events).toEqual(["row-prepped"])
  })

  it("keeps the row pending when the builder has nothing yet", async () => {
    const h = harness()
    await h.prep.prepIfStale(entry(), rule({ buildContent: async () => null }), h.ctx, h.repo)
    expect(h.repo.updatePrepState).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
  })

  it("degrades a row whose builder threw, and still announces it", async () => {
    const h = harness()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await h.prep.prepIfStale(
      entry(),
      rule({
        buildContent: async () => {
          throw new Error("llm down")
        },
      }),
      h.ctx,
      h.repo
    )
    expect(h.repo.updatePrepState).toHaveBeenCalledWith("msg-1", "degraded", NOW)
    expect(h.events).toEqual(["row-prepped"])
    warn.mockRestore()
  })

  it("builds a row once while an earlier build is still running", async () => {
    const h = harness()
    let release: () => void = () => undefined
    const build = vi.fn(
      () =>
        new Promise<{ bodyMd: string }>((resolve) => {
          release = () => resolve({ bodyMd: "Body" })
        })
    )
    const first = h.prep.prepIfStale(entry(), rule({ buildContent: build }), h.ctx, h.repo)
    await h.prep.prepIfStale(entry(), rule({ buildContent: build }), h.ctx, h.repo)
    release()
    await first
    expect(build).toHaveBeenCalledOnce()
  })
})

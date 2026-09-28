import { describe, expect, it, vi } from "vitest"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ProactiveStateEntry } from "@lib/domain/ports/proactiveStateRepository.js"
import { createProactivePlannerRun } from "../planNotifications.js"
import type { ProactiveContext, ResolvedProactiveRule } from "../types.js"

const DAY_MS = 86_400_000
const NOW = new Date(2026, 5, 1, 12, 0, 0, 0).getTime()

const LIVE: ProactiveStateEntry = {
  chatMessageId: "msg-1" as ChatMessageId,
  sessionId: "sess-1" as ChatSessionId,
  ruleKind: "holiday",
  ruleDate: "2026-06-03",
  prepState: "ready",
  preparedAt: NOW,
  bodyMd: "Body",
  visibleAt: null,
  notify: true,
  createdAt: NOW,
  seenAt: null,
}

function harness(
  opts: { sessionTitle?: string | null; daily?: boolean; closeAfter?: number } = {}
) {
  const notifications = {
    schedule: vi.fn<(n: { id: number; title: string; at: number }) => Promise<void>>(
      async () => undefined
    ),
    cancel: vi.fn<(id: number) => Promise<void>>(async () => undefined),
  }
  const repos = {
    proactiveState: { listByPrepStates: async () => [LIVE] },
    chatSessions: {
      getById: async () => (opts.sessionTitle === undefined ? null : { title: opts.sessionTitle }),
    },
  }
  // The user database closes after `closeAfter` lookups (a sign-out mid-tick).
  let lookups = 0
  const repositories = vi.fn(() => {
    lookups += 1
    return opts.closeAfter !== undefined && lookups > opts.closeAfter ? null : repos
  })
  const ctx = { nowMs: NOW, repos } as unknown as ProactiveContext
  const rules = [
    {
      config: { id: "holiday" },
      handler: {
        id: "holiday",
        collectNotifications: () => [
          {
            id: 7,
            fireAtMs: NOW + 2 * DAY_MS,
            priority: 50,
            kind: "holiday",
            title: "",
            body: "B",
          },
        ],
      },
    },
  ] as unknown as ResolvedProactiveRule[]
  const run = createProactivePlannerRun({
    notifications,
    reportFailure: vi.fn(),
    t: (key) => `t:${key}`,
    repositories: repositories as never,
    dailyReminder: () => ({ enabled: opts.daily ?? false, time: [9, 0] }),
  })
  return { notifications, ctx, rules, run, repositories }
}

describe("createProactivePlannerRun", () => {
  it("cancels the legacy recurring daily alarm once", async () => {
    const h = harness()
    vi.spyOn(console, "info").mockImplementation(() => undefined)
    await h.run(h.ctx, h.rules, "foreground")
    await h.run(h.ctx, h.rules, "foreground")
    expect(h.notifications.cancel.mock.calls.filter(([id]) => id === 9001)).toHaveLength(1)
  })

  it("titles a session-backed push after its chat session", async () => {
    const h = harness({ sessionTitle: "  Janmashtami  " })
    await h.run(h.ctx, h.rules, "foreground")
    expect(h.notifications.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, title: "Janmashtami", body: "B" })
    )
  })

  it("falls back to the app name when the session has no title", async () => {
    const h = harness({ sessionTitle: null })
    await h.run(h.ctx, h.rules, "foreground")
    expect(h.notifications.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, title: "t:app.name" })
    )
  })

  it("adds the daily reminder when it is on, one push per day at most", async () => {
    const h = harness({ daily: true })
    await h.run(h.ctx, h.rules, "foreground")
    const scheduledDays = h.notifications.schedule.mock.calls.map(([n]) =>
      new Date(n.at).toDateString()
    )
    expect(new Set(scheduledDays).size).toBe(scheduledDays.length)
    expect(scheduledDays.length).toBeGreaterThan(1)
  })

  it("resolves without scheduling when the user database is already closed", async () => {
    const h = harness({ closeAfter: 0 })
    await expect(h.run(h.ctx, h.rules, "foreground")).resolves.toBeUndefined()
    expect(h.notifications.schedule).not.toHaveBeenCalled()
    expect(h.notifications.cancel).not.toHaveBeenCalled()
  })

  it("drops a push whose title lookup finds the database closed, and still resolves", async () => {
    const h = harness({ sessionTitle: "Janmashtami", closeAfter: 1 })
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(h.run(h.ctx, h.rules, "foreground")).resolves.toBeUndefined()
    expect(h.notifications.schedule).not.toHaveBeenCalled()
    expect(h.repositories).toHaveBeenCalledTimes(2)
  })
})

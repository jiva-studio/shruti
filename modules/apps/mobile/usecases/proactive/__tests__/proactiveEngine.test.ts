import { describe, expect, it, vi } from "vitest"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ProactiveConfig, ProactiveRuleId } from "@lib/domain/config.js"
import type {
  IProactiveStateRepository,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import { createProactiveEngine, type ProactiveEngineDeps } from "../proactiveEngine.js"
import type { ProactivePrep } from "../prepProactiveRow.js"
import type { ProactiveContext, ProactiveEvent, ProactiveRuleHandler } from "../types.js"

const NOW = new Date(2026, 5, 1, 12, 0, 0, 0).getTime()

function entry(ruleKind: ProactiveRuleId): ProactiveStateEntry {
  return {
    chatMessageId: `msg-${ruleKind}` as ChatMessageId,
    sessionId: "sess-1" as ChatSessionId,
    ruleKind,
    ruleDate: "2026-06-01",
    prepState: "pending",
    preparedAt: null,
    bodyMd: "",
    visibleAt: null,
    notify: false,
    createdAt: NOW,
    seenAt: null,
  }
}

function handler(id: ProactiveRuleId, over: Partial<ProactiveRuleHandler> = {}) {
  return {
    id,
    detect: vi.fn(async () => []),
    validate: vi.fn(async () => true),
    buildContent: vi.fn(async () => null),
    ...over,
  } as ProactiveRuleHandler & { detect: ReturnType<typeof vi.fn> }
}

interface Harness {
  readonly deps: ProactiveEngineDeps
  readonly events: ProactiveEvent[]
  readonly gathered: { count: number }
  readonly prep: { [K in keyof ProactivePrep]: ReturnType<typeof vi.fn> }
  readonly planner: ReturnType<typeof vi.fn>
  readonly repo: IProactiveStateRepository & { sweepTerminal: ReturnType<typeof vi.fn> }
}

function harness(over: {
  open?: boolean
  config?: ProactiveConfig | null
  rules?: readonly ProactiveRuleHandler[]
  live?: readonly ProactiveStateEntry[]
  ctx?: Partial<ProactiveContext>
  onCooldown?: boolean
  stillValid?: boolean
}): Harness {
  const events: ProactiveEvent[] = []
  const gathered = { count: 0 }
  const repo = {
    listByPrepStates: vi.fn(async () => over.live ?? []),
    findByRuleAndDate: vi.fn(async () => null),
    sweepTerminal: vi.fn(async () => 0),
  } as unknown as Harness["repo"]
  const prep = {
    isOnCooldown: vi.fn(async () => over.onCooldown ?? false),
    reValidateRow: vi.fn(async () => over.stillValid ?? true),
    prepIfStale: vi.fn(async () => undefined),
  }
  const planner = vi.fn(async () => undefined)
  const ctx = {
    nowMs: NOW,
    completedTracks: 0,
    repos: { chatSessions: {}, unitOfWork: {} },
    ...over.ctx,
  } as unknown as ProactiveContext
  const deps: ProactiveEngineDeps = {
    proactiveState: () => (over.open === false ? null : repo),
    readConfig: async () => (over.config === undefined ? null : over.config),
    gatherContext: async () => {
      gathered.count++
      return ctx
    },
    rules: over.rules ?? [],
    prep,
    runPlanner: planner,
    emit: (e) => events.push(e),
  }
  return { deps, events, gathered, prep, planner, repo }
}

describe("createProactiveEngine — tick", () => {
  it("reports not-ready and touches nothing while the databases are closed", async () => {
    const h = harness({ open: false, rules: [handler("holiday")] })

    expect(await createProactiveEngine(h.deps).tick()).toBe("not-ready")
    expect(h.events).toEqual([])
    expect(h.gathered.count).toBe(0)
  })

  it("announces the tick, then stops at the master kill switch", async () => {
    const h = harness({
      config: { master_enabled: false } as ProactiveConfig,
      rules: [handler("holiday")],
    })

    expect(await createProactiveEngine(h.deps).tick()).toBe("ran")
    expect(h.events).toEqual(["tick-ready"])
    expect(h.gathered.count).toBe(0)
    expect(h.planner).not.toHaveBeenCalled()
  })

  it("detects only for rules that are eligible and off cooldown", async () => {
    const eligible = handler("holiday")
    const gated = handler("smart_library_hint")
    const h = harness({ rules: [eligible, gated] })

    await createProactiveEngine(h.deps).tick()

    // smart_library_hint's bundled eligibility needs three completed tracks.
    expect(eligible.detect).toHaveBeenCalledOnce()
    expect(gated.detect).not.toHaveBeenCalled()
  })

  it("skips detection for a rule still cooling down", async () => {
    const rule = handler("holiday")
    const h = harness({ rules: [rule], onCooldown: true })

    await createProactiveEngine(h.deps).tick()

    expect(rule.detect).not.toHaveBeenCalled()
  })

  it("preps only the live rows that still validate, then plans the foreground pushes", async () => {
    const h = harness({
      rules: [handler("holiday")],
      live: [entry("holiday"), entry("weekly_digest")],
    })

    await createProactiveEngine(h.deps).tick()

    // weekly_digest has no handler here, so its row is left alone.
    expect(h.prep.reValidateRow).toHaveBeenCalledTimes(1)
    expect(h.prep.prepIfStale).toHaveBeenCalledTimes(1)
    expect(h.planner).toHaveBeenCalledWith(expect.anything(), expect.any(Array), "foreground")
  })

  it("does not prep a row that stopped validating", async () => {
    const h = harness({ rules: [handler("holiday")], live: [entry("holiday")], stillValid: false })

    await createProactiveEngine(h.deps).tick()

    expect(h.prep.prepIfStale).not.toHaveBeenCalled()
  })

  it("plans nothing when the published config switches every rule off", async () => {
    const h = harness({
      config: { rules: [{ id: "holiday", enabled: false }] } as unknown as ProactiveConfig,
      rules: [handler("holiday")],
    })

    await createProactiveEngine(h.deps).tick()

    expect(h.planner).not.toHaveBeenCalled()
  })
})

describe("createProactiveEngine — pause", () => {
  it("runs each eligible pause hook, survives a throwing one, and plans the background", async () => {
    const throwing = handler("holiday", {
      onAppPause: vi.fn(async () => {
        throw new Error("boom")
      }),
    })
    const hooked = handler("weekly_digest", { onAppPause: vi.fn(async () => undefined) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    // weekly_digest's bundled eligibility needs listening history.
    const h = harness({
      rules: [throwing, hooked],
      ctx: { totalListenedSeconds: 3600, completedTracks: 5 },
    })

    await createProactiveEngine(h.deps).pause()

    expect(throwing.onAppPause).toHaveBeenCalledOnce()
    expect(hooked.onAppPause).toHaveBeenCalledOnce()
    expect(h.planner).toHaveBeenCalledWith(expect.anything(), expect.any(Array), "background")
    warn.mockRestore()
  })

  it("does nothing while the databases are closed", async () => {
    const h = harness({ open: false })

    await createProactiveEngine(h.deps).pause()

    expect(h.gathered.count).toBe(0)
  })
})

describe("createProactiveEngine — sweep", () => {
  it("drops terminal rows older than ninety days", async () => {
    const h = harness({})

    await createProactiveEngine(h.deps).sweep(NOW)

    expect(h.repo.sweepTerminal).toHaveBeenCalledWith(Math.floor(NOW / 1000) - 90 * 86_400)
  })
})

describe("createProactiveEngine — what each pass reads and skips", () => {
  it("re-validates the pending, ready and degraded rows of handled rules only", async () => {
    const handled = entry("holiday")
    const h = harness({ rules: [handler("holiday")], live: [entry("weekly_digest"), handled] })

    await createProactiveEngine(h.deps).tick()

    expect(h.repo.listByPrepStates).toHaveBeenCalledWith(["pending", "ready", "degraded"])
    expect(h.prep.reValidateRow).toHaveBeenCalledOnce()
    expect(h.prep.reValidateRow.mock.calls[0]![0]).toBe(handled)
  })

  it("stops a pause at the master kill switch", async () => {
    const hook = vi.fn(async () => undefined)
    const h = harness({
      config: { master_enabled: false } as ProactiveConfig,
      rules: [handler("holiday", { onAppPause: hook })],
    })

    await createProactiveEngine(h.deps).pause()

    expect(h.gathered.count).toBe(0)
    expect(hook).not.toHaveBeenCalled()
    expect(h.planner).not.toHaveBeenCalled()
  })

  it("skips the pause hook of a rule the user is not eligible for", async () => {
    const hook = vi.fn(async () => undefined)
    // weekly_digest's bundled eligibility needs listening history; none here.
    const h = harness({ rules: [handler("weekly_digest", { onAppPause: hook })] })

    await createProactiveEngine(h.deps).pause()

    expect(hook).not.toHaveBeenCalled()
    expect(h.planner).toHaveBeenCalledWith(expect.anything(), expect.any(Array), "background")
  })

  it("sweeps nothing and warns about nothing while the databases are closed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const h = harness({ open: false })

    await createProactiveEngine(h.deps).sweep(NOW)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("swallows a failed sweep", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const h = harness({})
    h.repo.sweepTerminal.mockRejectedValueOnce(new Error("locked"))

    await expect(createProactiveEngine(h.deps).sweep(NOW)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

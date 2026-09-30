// @vitest-environment jsdom
import { createApp, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppLifecycleState, AppLifecycleSubscription } from "@ports/app/index.js"

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(err: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ctx = vi.hoisted(() => ({
  engine: null as unknown as {
    tick: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    sweep: ReturnType<typeof vi.fn>
  },
  onStateChange: null as unknown as ReturnType<
    typeof vi.fn<
      (listener: (state: AppLifecycleState) => void) => Promise<AppLifecycleSubscription>
    >
  >,
  reportError: null as unknown as ReturnType<typeof vi.fn<(...args: unknown[]) => void>>,
  emit: null as unknown as ReturnType<typeof vi.fn<(...args: unknown[]) => void>>,
  handlers: new Map<string, () => void>(),
}))

vi.mock("@usecases/proactive/proactiveEngine.js", () => ({
  createProactiveEngine: () => ctx.engine,
}))
vi.mock("@usecases/proactive/planNotifications.js", () => ({
  createProactivePlannerRun: () => async () => {},
}))
vi.mock("@usecases/proactive/prepProactiveRow.js", () => ({
  createProactivePrep: () => ({}),
}))
vi.mock("@usecases/proactive/rules/index.js", () => ({ PROACTIVE_RULES: [] }))
vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (_key: string, initial: unknown) => ref(initial),
}))
vi.mock("@shruti/composables/useProactiveContext.js", () => ({
  useProactiveContext: () => async () => ({}),
}))
vi.mock("@shruti/services/notifyPlannerFailures.js", () => ({
  reportNotifyPlannerFailure: vi.fn(),
}))
vi.mock("@shruti/services/proactiveEvents.js", () => ({
  emit: (...args: unknown[]) => ctx.emit(...args),
  on: (event: string, handler: () => void) => {
    ctx.handlers.set(event, handler)
    return () => ctx.handlers.delete(event)
  },
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: (...args: unknown[]) => ctx.reportError(...args),
}))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({}),
    clock: { now: () => 0 },
    notifications: {},
    appLifecycle: { onStateChange: ctx.onStateChange },
  }),
}))

import { useProactiveScheduler } from "../useProactiveScheduler.js"

type Listener = (state: AppLifecycleState) => void

let listener: Listener | null = null

function mountScheduler(): ReturnType<typeof createApp> {
  const app = createApp({
    setup() {
      useProactiveScheduler()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return app
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function goBackground(): void {
  listener?.({ isActive: false })
}

function comeForeground(): void {
  listener?.({ isActive: true })
}

let handle: AppLifecycleSubscription & { remove: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.useFakeTimers()
  listener = null
  handle = { remove: vi.fn(async () => {}) }
  ctx.engine = {
    tick: vi.fn(async () => "ran" as const),
    pause: vi.fn(async () => {}),
    sweep: vi.fn(async () => {}),
  }
  ctx.onStateChange = vi.fn(async (next: Listener): Promise<AppLifecycleSubscription> => {
    listener = next
    return handle
  })
  ctx.reportError = vi.fn()
  ctx.emit = vi.fn()
  ctx.handlers.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useProactiveScheduler — one pass at a time", () => {
  it("runs the background plan only after the foreground tick in flight has settled", async () => {
    const tick = deferred<"ran">()
    ctx.engine.tick.mockReturnValueOnce(tick.promise)
    const app = mountScheduler()
    await flush()

    goBackground()
    await flush()
    expect(ctx.engine.pause).not.toHaveBeenCalled()

    tick.resolve("ran")
    await flush()
    expect(ctx.engine.pause).toHaveBeenCalledOnce()
    app.unmount()
  })

  it("starts a foreground tick only after the background plan in flight has settled", async () => {
    const app = mountScheduler()
    await flush()
    ctx.engine.tick.mockClear()
    const pause = deferred<void>()
    ctx.engine.pause.mockReturnValueOnce(pause.promise)

    goBackground()
    await flush()
    comeForeground()
    await flush()
    expect(ctx.engine.tick).not.toHaveBeenCalled()

    pause.resolve()
    await flush()
    expect(ctx.engine.tick).toHaveBeenCalledOnce()
    app.unmount()
  })

  it("runs a foreground tick after a background plan requested while a tick was in flight", async () => {
    const tick = deferred<"ran">()
    ctx.engine.tick.mockReturnValueOnce(tick.promise)
    const app = mountScheduler()
    await flush()

    goBackground()
    comeForeground()
    tick.resolve("ran")
    await flush()

    expect(ctx.engine.pause).toHaveBeenCalledOnce()
    expect(ctx.engine.tick).toHaveBeenCalledTimes(2)
    expect(ctx.engine.pause.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.engine.tick.mock.invocationCallOrder[1]!
    )
    app.unmount()
  })

  it("runs one follow-up tick for the requests made while a tick is in flight", async () => {
    const tick = deferred<"ran">()
    ctx.engine.tick.mockReturnValueOnce(tick.promise)
    const app = mountScheduler()
    await flush()

    comeForeground()
    comeForeground()
    comeForeground()
    await flush()
    expect(ctx.engine.tick).toHaveBeenCalledOnce()
    tick.resolve("ran")
    await flush()

    expect(ctx.engine.tick).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it("runs a tick when settings ask for a replan", async () => {
    const app = mountScheduler()
    await flush()
    ctx.engine.tick.mockClear()

    ctx.handlers.get("replan")?.()
    await flush()

    expect(ctx.engine.tick).toHaveBeenCalledOnce()
    app.unmount()
  })
})

describe("useProactiveScheduler — failures", () => {
  it("reports a tick that throws instead of leaving the rejection unhandled", async () => {
    const boom = new Error("planner exploded")
    ctx.engine.tick.mockRejectedValueOnce(boom)
    const app = mountScheduler()
    await flush()

    expect(ctx.reportError).toHaveBeenCalledWith("proactive", boom)
    expect(ctx.emit).toHaveBeenCalledWith("tick-settled")
    app.unmount()
  })

  it("reports a background plan that throws", async () => {
    const boom = new Error("background plan failed")
    ctx.engine.pause.mockRejectedValueOnce(boom)
    const app = mountScheduler()
    await flush()

    goBackground()
    await flush()

    expect(ctx.reportError).toHaveBeenCalledWith("proactive", boom)
    app.unmount()
  })
})

describe("useProactiveScheduler — unmount", () => {
  it("cancels the not-ready retry", async () => {
    ctx.engine.tick.mockResolvedValue("not-ready")
    const app = mountScheduler()
    await flush()
    expect(ctx.engine.tick).toHaveBeenCalledOnce()

    app.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(ctx.engine.tick).toHaveBeenCalledOnce()
  })
  it("drops a background plan still queued behind a tick at unmount", async () => {
    const tick = deferred<"ran">()
    ctx.engine.tick.mockReturnValueOnce(tick.promise)
    const app = mountScheduler()
    await flush()
    goBackground()

    app.unmount()
    tick.resolve("ran")
    await flush()

    expect(ctx.engine.pause).not.toHaveBeenCalled()
  })

  it("keeps the lifecycle listener attached while mounted", async () => {
    const app = mountScheduler()
    await flush()
    expect(handle.remove).not.toHaveBeenCalled()

    app.unmount()
    await flush()
    expect(handle.remove).toHaveBeenCalledOnce()
  })

  it("reports a lifecycle listener that fails to register", async () => {
    const boom = new Error("bridge gone")
    ctx.onStateChange.mockRejectedValueOnce(boom)
    const app = mountScheduler()
    await flush()

    expect(ctx.reportError).toHaveBeenCalledWith("proactive", boom)
    app.unmount()
  })

  it("removes a lifecycle listener that registers after unmount", async () => {
    const registered = deferred<AppLifecycleSubscription>()
    ctx.onStateChange.mockImplementationOnce((next: Listener) => {
      listener = next
      return registered.promise
    })
    const app = mountScheduler()
    app.unmount()

    registered.resolve(handle)
    await flush()

    expect(handle.remove).toHaveBeenCalledOnce()
  })

  it("reports a listener that fails to detach", async () => {
    const boom = new Error("bridge gone")
    handle.remove.mockRejectedValueOnce(boom)
    const app = mountScheduler()
    await flush()

    app.unmount()
    await flush()

    expect(ctx.reportError).toHaveBeenCalledWith("proactive", boom)
  })
})

describe("useProactiveScheduler — not-ready retries", () => {
  it("retries a tick that found the databases closed every five seconds, sixty times", async () => {
    ctx.engine.tick.mockResolvedValue("not-ready")
    const app = mountScheduler()
    await flush()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(ctx.engine.tick).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5_000 * 70)
    expect(ctx.engine.tick).toHaveBeenCalledTimes(61)
    app.unmount()
  })

  it("starts a fresh retry run after a tick that ran", async () => {
    ctx.engine.tick.mockResolvedValue("not-ready")
    const app = mountScheduler()
    await flush()
    await vi.advanceTimersByTimeAsync(5_000 * 70)

    ctx.engine.tick.mockResolvedValueOnce("ran")
    comeForeground()
    await flush()
    comeForeground()
    await flush()
    ctx.engine.tick.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(ctx.engine.tick).toHaveBeenCalledOnce()
    app.unmount()
  })

  it("starts a fresh retry run after a tick that threw", async () => {
    ctx.engine.tick.mockResolvedValue("not-ready")
    const app = mountScheduler()
    await flush()
    await vi.advanceTimersByTimeAsync(5_000 * 70)

    ctx.engine.tick.mockRejectedValueOnce(new Error("planner exploded"))
    comeForeground()
    await flush()
    comeForeground()
    await flush()
    ctx.engine.tick.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(ctx.engine.tick).toHaveBeenCalledOnce()
    app.unmount()
  })
})

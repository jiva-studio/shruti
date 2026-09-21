// @vitest-environment jsdom
import { createApp, nextTick, reactive, type App as VueApp } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  setProgressInterval: vi.fn(),
  removeListener: vi.fn(),
  listener: undefined as ((state: { isActive: boolean }) => void) | undefined,
  addListenerSettles: true,
}))

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn((_event: string, fn: (state: { isActive: boolean }) => void) => {
      harness.listener = fn
      return harness.addListenerSettles
        ? Promise.resolve({ remove: harness.removeListener })
        : new Promise(() => {})
    }),
  },
}))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ audioPlayer: { setProgressInterval: harness.setProgressInterval } }),
}))

const transcript = reactive({ open: false })
vi.mock("@lectorium/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => transcript,
}))

import { usePlayerProgressCadence } from "../usePlayerProgressCadence.js"

const TRANSCRIPT_OPEN_MS = 500
const FOREGROUND_MS = 1000
const BACKGROUND_MS = 5000

const mounted: VueApp[] = []

function mount(): VueApp {
  const app = createApp({
    setup() {
      usePlayerProgressCadence()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  mounted.push(app)
  return app
}

function unmountAll(): void {
  for (const app of mounted.splice(0)) app.unmount()
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

function intervals(): number[] {
  return harness.setProgressInterval.mock.calls.map((c) => c[0] as number)
}

describe("usePlayerProgressCadence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.listener = undefined
    harness.addListenerSettles = true
    transcript.open = false
  })

  afterEach(() => {
    unmountAll()
  })

  it("starts at the foreground cadence with the transcript closed", async () => {
    mount()
    await flush()
    expect(intervals()).toEqual([FOREGROUND_MS])
  })

  it("starts fast when the transcript is already open", async () => {
    transcript.open = true
    mount()
    await flush()
    expect(intervals()).toEqual([TRANSCRIPT_OPEN_MS])
  })

  it("speeds up when the transcript opens and slows down when it closes", async () => {
    mount()
    await flush()

    transcript.open = true
    await nextTick()
    transcript.open = false
    await nextTick()

    expect(intervals()).toEqual([FOREGROUND_MS, TRANSCRIPT_OPEN_MS, FOREGROUND_MS])
  })

  it("drops to a heartbeat while the app is hidden and restores on resume", async () => {
    mount()
    await flush()

    harness.listener!({ isActive: false })
    harness.listener!({ isActive: true })

    expect(intervals()).toEqual([FOREGROUND_MS, BACKGROUND_MS, FOREGROUND_MS])
  })

  it("keeps the heartbeat while hidden even with the transcript open", async () => {
    mount()
    await flush()
    harness.listener!({ isActive: false })

    transcript.open = true
    await nextTick()
    expect(intervals()).toEqual([FOREGROUND_MS, BACKGROUND_MS])

    // Coming back with the transcript still open goes straight to fast.
    harness.listener!({ isActive: true })
    expect(intervals()).toEqual([FOREGROUND_MS, BACKGROUND_MS, TRANSCRIPT_OPEN_MS])
  })

  it("does not re-tell the engine a cadence it already has", async () => {
    mount()
    await flush()

    harness.listener!({ isActive: true })
    transcript.open = false
    await nextTick()

    expect(intervals()).toEqual([FOREGROUND_MS])
  })

  it("stops listening once unmounted", async () => {
    const app = mount()
    await flush()
    mounted.splice(mounted.indexOf(app), 1)
    app.unmount()
    await flush()

    expect(harness.removeListener).toHaveBeenCalledTimes(1)

    transcript.open = true
    await nextTick()
    expect(intervals()).toEqual([FOREGROUND_MS])
  })

  it("unmounts cleanly while the listener registration is still in flight", async () => {
    harness.addListenerSettles = false
    const app = mount()
    await flush()
    mounted.splice(mounted.indexOf(app), 1)

    expect(() => app.unmount()).not.toThrow()
    expect(harness.removeListener).not.toHaveBeenCalled()
  })
})

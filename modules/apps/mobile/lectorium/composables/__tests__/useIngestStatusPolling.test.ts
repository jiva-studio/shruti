// @vitest-environment jsdom
import { createApp, ref } from "vue"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"

/**
 * How many polling loops a set of mounted surfaces adds up to.
 *
 * Three views ask for live ingest status — the chat page, "My library" and the
 * library shelf on the Search landing — and Ionic keeps every page it has shown
 * mounted. One loop per view therefore meant a user who had opened all three
 * paid 3× the `GET /orchestrator/run/{jobId}` traffic for the same lecture, at
 * a 1.2s cadence while it downloaded (#1589). What the surfaces are asking for
 * is one shared answer, so there is one loop no matter how many of them ask.
 */
const ctx = vi.hoisted(() => ({
  status: vi.fn(),
  requestSync: vi.fn(),
  applyLiveStatus: vi.fn(),
  setLiveStage: vi.fn(),
  pending: [{ id: "job-1" }] as { id: string }[],
}))
const { status, requestSync, applyLiveStatus, setLiveStage } = ctx

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    activeServer: ref({ orchestratorBaseUrl: "https://orchestrator.test" }),
    ingestClient: { status: ctx.status },
  }),
}))
vi.mock("@lectorium/services/syncEvents.js", () => ({ requestSync: ctx.requestSync }))
vi.mock("@lectorium/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({
    get pendingItems() {
      return ctx.pending
    },
    applyLiveStatus: ctx.applyLiveStatus,
    setLiveStage: ctx.setLiveStage,
  }),
}))

import { useIngestStatusPolling } from "../useIngestStatusPolling.js"
import { useIngestPollingStore } from "@lectorium/stores/useIngestPollingStore.js"

/** A mounted surface that wants live ingest status. */
function mountConsumer(): ReturnType<typeof createApp> {
  const app = createApp({
    setup() {
      useIngestStatusPolling()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return app
}

/** Let the mount-time tick and its awaited status calls settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("useIngestStatusPolling — one loop for every consumer", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    status.mockReset()
    requestSync.mockReset()
    applyLiveStatus.mockReset()
    setLiveStage.mockReset()
    status.mockResolvedValue({ state: "processing", stage: "transcribing" })
    ctx.pending = [{ id: "job-1" }]
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("polls a pending item once per tick with three surfaces mounted", async () => {
    // The three real call sites, all mounted at once — the state Ionic leaves
    // the app in after the user has visited Search, Chat and My Library.
    mountConsumer()
    mountConsumer()
    mountConsumer()
    await flush()

    // Before: three mount-time ticks, one per view, all asking the server the
    // same question about the same job.
    expect(status).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3000)
    await flush()

    // …and three self-scheduling loops thereafter.
    expect(status).toHaveBeenCalledTimes(2)
  })

  it("keeps polling while any surface is still mounted", async () => {
    const first = mountConsumer()
    const second = mountConsumer()
    await flush()
    status.mockClear()

    first.unmount()
    await vi.advanceTimersByTimeAsync(3000)
    await flush()

    // The surviving surface still gets live status — and still only one poll.
    expect(status).toHaveBeenCalledTimes(1)
    void second
  })

  it("stops polling once the last surface unmounts", async () => {
    const first = mountConsumer()
    const second = mountConsumer()
    await flush()
    status.mockClear()

    first.unmount()
    second.unmount()
    await vi.advanceTimersByTimeAsync(30000)
    await flush()

    expect(status).not.toHaveBeenCalled()
  })

  it("polls again when a surface is mounted a second time", async () => {
    // Navigating away and back must not leave the app with a dead loop: the
    // refcount going 1 → 0 → 1 has to start a new one.
    const first = mountConsumer()
    await flush()
    first.unmount()
    status.mockClear()

    mountConsumer()
    await flush()

    expect(status).toHaveBeenCalledTimes(1)
  })

  it("drops the answers of a poll that was in flight when the data was wiped", async () => {
    // "Clear user data" / delete-account empties the library underneath a poll
    // that is still awaiting its answers. They describe items that no longer
    // exist, and a live stage written for one of them would paint a progress
    // ring on a lecture the user just deleted.
    let answer: ((s: unknown) => void) | undefined
    status.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    mountConsumer()
    await flush()

    useIngestPollingStore().reset()
    ctx.pending = []
    answer?.({ state: "ready" })
    await flush()

    expect(applyLiveStatus).not.toHaveBeenCalled()
    expect(setLiveStage).not.toHaveBeenCalled()
    expect(requestSync).not.toHaveBeenCalled()
  })

  it("asks the server nothing while no item is pending", async () => {
    ctx.pending = []
    mountConsumer()
    await flush()
    await vi.advanceTimersByTimeAsync(9000)
    await flush()

    expect(status).not.toHaveBeenCalled()
  })
})

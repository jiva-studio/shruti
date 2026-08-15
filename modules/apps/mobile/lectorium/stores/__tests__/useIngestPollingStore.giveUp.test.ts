import { ref } from "vue"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The loop had no give-up. An item the orchestrator will never report terminal
 * kept `pendingItems` non-empty, so the poll ran at ~20 requests/minute for the
 * rest of the session — and the per-item `catch {}` swallowed the evidence,
 * including a permanent 404 (#1834).
 *
 * Everything else about the loop is deliberate and is left alone here: the
 * cadence, and the `retain()` / `stop()` gating that already keeps it bound to
 * mounted surfaces.
 */
const ctx = vi.hoisted(() => ({
  status: vi.fn(),
  requestSync: vi.fn(),
  applyLiveStatus: vi.fn(),
  setLiveStage: vi.fn(),
  pending: [{ id: "job-1" }] as { id: string }[],
}))

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

import { IngestGatewayError } from "@infra/ingest/http/ingestClient.js"
import { useIngestPollingStore } from "../useIngestPollingStore.js"

const POLL_INTERVAL_MS = 3000

/** Let the first tick and its awaited status calls settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("useIngestPollingStore — giving up on an item that never lands", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    ctx.status.mockReset()
    ctx.requestSync.mockReset()
    ctx.applyLiveStatus.mockReset()
    ctx.setLiveStage.mockReset()
    ctx.pending = [{ id: "job-1" }]
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("stops asking after a permanent 404 instead of swallowing it forever", async () => {
    ctx.status.mockRejectedValue(new IngestGatewayError(404, "ingest api responded 404"))
    const store = useIngestPollingStore()
    store.retain()
    await flush()

    expect(ctx.status).toHaveBeenCalledTimes(1)
    // The run does not exist and never will; ten more ticks must ask nothing.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    expect(ctx.status).toHaveBeenCalledTimes(1)
    // Sync is the fallback the item was just handed back to.
    expect(ctx.requestSync).toHaveBeenCalled()
  })

  it("keeps retrying a transient failure, then gives up after five in a row", async () => {
    ctx.status.mockRejectedValue(new Error("boom"))
    const store = useIngestPollingStore()
    store.retain()
    await flush()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(ctx.status).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    expect(ctx.status).toHaveBeenCalledTimes(5)
  })

  it("forgets the failure run once a read succeeds", async () => {
    ctx.status.mockRejectedValue(new Error("boom"))
    const store = useIngestPollingStore()
    store.retain()
    await flush()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(ctx.status).toHaveBeenCalledTimes(4)

    ctx.status.mockResolvedValue({ state: "processing", stage: "transcribing" })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    ctx.status.mockRejectedValue(new Error("boom"))

    // Four more failures is one short of the budget again — still polling.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(ctx.status).toHaveBeenCalledTimes(9)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(ctx.status).toHaveBeenCalledTimes(10)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    expect(ctx.status).toHaveBeenCalledTimes(10)
  })

  it("gives up on an item that answers happily but never reaches a terminal state", async () => {
    ctx.status.mockResolvedValue({ state: "processing", stage: "transcribing" })
    const store = useIngestPollingStore()
    store.retain()
    await flush()

    await vi.advanceTimersByTimeAsync(29 * 60_000)
    const before = ctx.status.mock.calls.length
    expect(before).toBeGreaterThan(100)

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    const after = ctx.status.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(ctx.status.mock.calls.length).toBe(after)
    expect(after).toBeGreaterThan(before)
  })

  it("a second pending item keeps being polled after the first is abandoned", async () => {
    ctx.pending = [{ id: "job-1" }, { id: "job-2" }]
    ctx.status.mockImplementation(async (id: string) => {
      if (id === "job-1") throw new IngestGatewayError(404, "ingest api responded 404")
      return { state: "processing", stage: "transcribing" }
    })
    const store = useIngestPollingStore()
    store.retain()
    await flush()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    const ids = ctx.status.mock.calls.map((c) => c[0] as string)
    expect(ids.filter((id) => id === "job-1")).toHaveLength(1)
    expect(ids.filter((id) => id === "job-2").length).toBeGreaterThan(3)
  })
})

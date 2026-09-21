import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IngestGatewayError } from "@infra/ingest/http/ingestClient.js"
import { createIngestPollWatchlist } from "../ingestPollWatchlist.js"

const GIVE_UP_AFTER_MS = 30 * 60_000
const FAILURE_COOLDOWN_MS = 60_000
const MAX_CONSECUTIVE_FAILURES = 5

function failRepeatedly(
  list: ReturnType<typeof createIngestPollWatchlist>,
  id: string,
  times: number,
  at: number
): boolean {
  let gaveUp = false
  for (let i = 0; i < times; i++) gaveUp = list.noteFailure(id, new Error("boom"), at)
  return gaveUp
}

describe("ingest poll watchlist", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("selects every freshly seen item", () => {
    const list = createIngestPollWatchlist()
    expect(list.selectActive(["a", "b"], 0)).toEqual({ active: ["a", "b"], gaveUp: false })
  })

  it("abandons an item that never reaches a terminal state", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    expect(list.selectActive(["a"], GIVE_UP_AFTER_MS).active).toEqual(["a"])

    const aged = list.selectActive(["a"], GIVE_UP_AFTER_MS + 1)
    expect(aged).toEqual({ active: [], gaveUp: true })
    expect(list.selectActive(["a"], GIVE_UP_AFTER_MS + 2)).toEqual({ active: [], gaveUp: false })
  })

  it("abandons on the spot for a status the orchestrator will never answer", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    expect(list.noteFailure("a", new IngestGatewayError(404, "not found"), 0)).toBe(true)
    expect(list.selectActive(["a"], 1).active).toEqual([])
  })

  it.each([403, 410])("abandons on the spot for a refused status read (%i)", (status) => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    expect(list.noteFailure("a", new IngestGatewayError(status, "refused"), 0)).toBe(true)
  })

  it("keeps polling a transient failure until the budget is spent", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    expect(failRepeatedly(list, "a", MAX_CONSECUTIVE_FAILURES - 1, 0)).toBe(false)
    expect(list.selectActive(["a"], 0).active).toEqual(["a"])

    expect(list.noteFailure("a", new Error("boom"), 0)).toBe(true)
    expect(list.selectActive(["a"], 0).active).toEqual([])
  })

  it("picks a cooled-down item back up with a fresh budget", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    failRepeatedly(list, "a", MAX_CONSECUTIVE_FAILURES, 0)
    expect(list.selectActive(["a"], FAILURE_COOLDOWN_MS - 1).active).toEqual([])
    expect(list.selectActive(["a"], FAILURE_COOLDOWN_MS).active).toEqual(["a"])

    expect(failRepeatedly(list, "a", MAX_CONSECUTIVE_FAILURES - 1, FAILURE_COOLDOWN_MS)).toBe(false)
  })

  it("ages out an item that only ever fails — the cooldown is not a loophole", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    for (let at = 0; at <= GIVE_UP_AFTER_MS; at += FAILURE_COOLDOWN_MS) {
      list.selectActive(["a"], at)
      failRepeatedly(list, "a", MAX_CONSECUTIVE_FAILURES, at)
    }
    expect(list.selectActive(["a"], GIVE_UP_AFTER_MS + 1)).toEqual({ active: [], gaveUp: true })
  })

  it("clears the failure run and the cooldown once a read answers", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    failRepeatedly(list, "a", MAX_CONSECUTIVE_FAILURES, 0)
    list.noteSuccess("a")
    expect(list.selectActive(["a"], 1).active).toEqual(["a"])
    expect(failRepeatedly(list, "a", MAX_CONSECUTIVE_FAILURES - 1, 1)).toBe(false)
  })

  it("forgets an item that left the pending set, so its clock restarts", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    list.selectActive([], GIVE_UP_AFTER_MS)
    expect(list.selectActive(["a"], GIVE_UP_AFTER_MS + 1).active).toEqual(["a"])
  })

  it("leaves the other pending items alone when one is abandoned", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a", "b"], 0)
    list.noteFailure("a", new IngestGatewayError(404, "not found"), 0)
    expect(list.selectActive(["a", "b"], 1).active).toEqual(["b"])
  })

  it("re-polls everything after a clear", () => {
    const list = createIngestPollWatchlist()
    list.selectActive(["a"], 0)
    list.noteFailure("a", new IngestGatewayError(404, "not found"), 0)
    list.clear()
    expect(list.selectActive(["a"], 1).active).toEqual(["a"])
  })
})

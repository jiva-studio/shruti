import { describe, expect, it, vi } from "vitest"
import type { TrackId } from "@lib/domain/core.js"
import { createInFlightTransfers } from "../inFlightTransfers.js"

const TRACK = "t1" as TrackId

function registry() {
  return createInFlightTransfers({ cancelTransfer: vi.fn() })
}

/** A queue job holding the track, with a task nobody has settled yet. */
function queueTransferFor(transfers: ReturnType<typeof registry>) {
  const handle = transfers.start(TRACK, "queue")
  const task = new Promise<string | null>(() => {})
  transfers.adopt(handle, task)
  return { handle, task }
}

describe("joining a running transfer", () => {
  it("hands back its task and raises its origin to the joiner's", () => {
    const transfers = registry()
    const { handle, task } = queueTransferFor(transfers)

    expect(transfers.join(TRACK, "user")).toBe(task)
    expect(handle.origin.current).toBe("user")
  })

  it("never lowers an origin", () => {
    const transfers = registry()
    const handle = transfers.start(TRACK, "user")
    transfers.adopt(handle, Promise.resolve(null))

    void transfers.join(TRACK, "queue")

    expect(handle.origin.current).toBe("user")
  })
})

// "Download anyway" waits for whatever holds the track to let go. Joining
// would raise that transfer's origin, and it may belong to an unrelated queue
// job whose failure notice would then lose its rate limit.
describe("waiting on a running transfer", () => {
  it("hands back its task without touching its origin", () => {
    const transfers = registry()
    const { handle, task } = queueTransferFor(transfers)

    expect(transfers.running(TRACK)).toBe(task)
    expect(handle.origin.current).toBe("queue")
  })

  it("has nothing to wait for when the track is free", () => {
    expect(registry().running(TRACK)).toBeUndefined()
  })

  it("has nothing to wait for before a task is adopted", () => {
    const transfers = registry()
    transfers.start(TRACK, "queue")

    expect(transfers.running(TRACK)).toBeUndefined()
  })
})

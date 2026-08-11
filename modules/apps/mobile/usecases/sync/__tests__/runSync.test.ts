import { describe, expect, it, vi } from "vitest"
import type { PushRequest, PushResponse } from "@lib/contracts"
import { runSync } from "../runSync.js"
import {
  FakeApply,
  FakeOutbox,
  FakeSyncClient,
  FakeSyncState,
  fakeUnitOfWork,
  hlc,
} from "./fakes.js"

describe("runSync — disabled engine", () => {
  it("no-ops when the gateway is null (anonymous / no profileBaseUrl)", async () => {
    const outbox = new FakeOutbox()
    const state = new FakeSyncState()
    const apply = new FakeApply()
    const getPullCursor = vi.spyOn(state, "getPullCursor")

    const result = await runSync({
      gateway: null,
      outbox,
      syncState: state,
      apply,
      unitOfWork: fakeUnitOfWork,
    })

    expect(result).toEqual({ skipped: true, pulled: 0, pushed: 0, conflicts: 0 })
    // Truly inert — it never touched local state or the network.
    expect(getPullCursor).not.toHaveBeenCalled()
    expect(outbox.rows).toHaveLength(0)
  })
})

describe("runSync — enabled cycle", () => {
  it("pulls then pushes and refreshes the changed stores", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const state = new FakeSyncState()
    const apply = new FakeApply()

    // One remote note to apply on pull...
    gateway.pullPages = [
      {
        changes: [{ server_seq: 1, collection: "notes", doc_id: "n1", op: "delete", hlc: hlc(10) }],
        cursor: 1,
        has_more: false,
      },
    ]
    // ...and one local playlist add to push.
    outbox.seed([
      {
        collection: "playlist_items",
        docId: "t1",
        op: "upsert",
        data: { track_id: "t1", added_at: 1, archived_at: null, collection_id: null },
        hlc: hlc(20),
        baseHlc: null,
      },
    ])
    gateway.pushHandler = (req): PushResponse => ({
      applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
      conflicts: [],
    })

    const refreshed: string[][] = []
    const result = await runSync({
      gateway,
      outbox,
      syncState: state,
      apply,
      unitOfWork: fakeUnitOfWork,
      refreshStores: (collections) => {
        refreshed.push([...collections])
      },
    })

    expect(result.skipped).toBe(false)
    expect(result.pulled).toBe(1)
    expect(result.pushed).toBe(1)
    // Pull ran before push (cursor advanced), and the note collection was
    // refreshed for the store.
    expect(state.pullCursor).toBe(1)
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).toContain("notes")
  })
})

/**
 * #1725: `/profile/sync/cursor` is the one route whose failure used to be
 * permanent — the ack threw out of `pullAndMerge` before the push, and because
 * `acked_seq` only advances on success the next cycle failed at the same line.
 * Nothing was ever uploaded again for the life of the install.
 */
describe("runSync — a failing cursor ack", () => {
  /** One playlist row to drain per cycle, applied wholesale by the server. */
  function seedPush(outbox: FakeOutbox, trackId: string): void {
    outbox.seed([
      {
        collection: "playlist_items",
        docId: trackId,
        op: "upsert",
        data: { track_id: trackId, added_at: 1, archived_at: null, collection_id: null },
        hlc: hlc(20),
        baseHlc: null,
      },
    ])
  }

  const applyAll = (req: PushRequest): PushResponse => ({
    applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
    conflicts: [],
  })

  it("still pushes, and keeps pushing on the cycles after it", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const state = new FakeSyncState()
    const apply = new FakeApply()

    gateway.pullPages = [
      {
        changes: [{ server_seq: 1, collection: "notes", doc_id: "n1", op: "delete", hlc: hlc(10) }],
        cursor: 1,
        has_more: false,
      },
      {
        changes: [{ server_seq: 2, collection: "notes", doc_id: "n2", op: "delete", hlc: hlc(11) }],
        cursor: 2,
        has_more: false,
      },
    ]
    gateway.ackHandler = () => {
      throw new Error("sync cursor failed: 500 Internal Server Error")
    }
    gateway.pushHandler = applyAll

    const run = () =>
      runSync({ gateway, outbox, syncState: state, apply, unitOfWork: fakeUnitOfWork })

    seedPush(outbox, "t1")
    const first = await run()

    expect(first.pushed).toBe(1)
    expect(gateway.pushRequests).toHaveLength(1)
    // The ack was attempted and lost; the cursor it acknowledges is local, so
    // it stays advanced while `acked_seq` does not — the server just compacts
    // later. That gap is what re-attempts the ack next cycle.
    expect(gateway.ackCalls).toEqual([{ device_id: "dev-1", acked_seq: 1 }])
    expect(state.pullCursor).toBe(1)
    expect(state.ackedSeq).toBe(0)

    // The second cycle is the one that made the bug permanent: it re-acks at
    // the still-unacknowledged cursor, fails identically, and must STILL push.
    seedPush(outbox, "t2")
    const second = await run()

    expect(second.pushed).toBe(1)
    expect(gateway.ackCalls).toHaveLength(2)
    expect(gateway.pushRequests).toHaveLength(2)
    expect(gateway.pushRequests[1]!.changes[0]!.doc_id).toBe("t2")
    expect(state.ackedSeq).toBe(0)

    // …and once the route recovers, `acked_seq` catches up to the cursor in one
    // go — the ack is a high-water mark, not a per-change acknowledgement.
    gateway.ackHandler = () => undefined
    seedPush(outbox, "t3")
    await run()

    expect(state.ackedSeq).toBe(2)
    expect(state.pullCursor).toBe(2)
    expect(gateway.pushRequests).toHaveLength(3)
  })
})

describe("runSync — a failing pull", () => {
  it("drains the outbox anyway and re-throws the pull failure", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const state = new FakeSyncState()
    const apply = new FakeApply()

    const boom = new Error("sync pull failed: 503 Service Unavailable")
    gateway.pull = async () => {
      throw boom
    }
    gateway.pushHandler = (req): PushResponse => ({
      applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
      conflicts: [],
    })
    outbox.seed([
      {
        collection: "notes",
        docId: "n1",
        op: "upsert",
        data: { id: "n1", text: "local only" },
        hlc: hlc(30),
        baseHlc: null,
      },
    ])

    await expect(
      runSync({ gateway, outbox, syncState: state, apply, unitOfWork: fakeUnitOfWork })
    ).rejects.toBe(boom)

    // The push ran regardless — a local write is the only copy of itself.
    expect(gateway.pushRequests).toHaveLength(1)
    expect(outbox.rows[0]!.sent).toBe(true)
  })
})

import { describe, expect, it, vi } from "vitest"
import type { PushResponse } from "@lib/contracts"
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

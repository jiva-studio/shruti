import { describe, expect, it } from "vitest"
import type { Change } from "@lib/contracts"
import { pullAndMerge } from "../pullAndMerge.js"
import { FakeApply, FakeSyncClient, FakeSyncState, fakeUnitOfWork, hlc } from "./fakes.js"

function deps(gateway: FakeSyncClient, state: FakeSyncState, apply: FakeApply) {
  return { gateway, syncState: state, apply, unitOfWork: fakeUnitOfWork }
}

describe("pullAndMerge — routing", () => {
  it("routes each collection's change to an upsert/tombstone and advances the cursor", async () => {
    const gateway = new FakeSyncClient()
    const state = new FakeSyncState()
    const apply = new FakeApply()

    const changes: Change[] = [
      {
        server_seq: 1,
        collection: "playlist_items",
        doc_id: "track-1",
        op: "upsert",
        hlc: hlc(1000),
        data: { track_id: "track-1", added_at: 1000, archived_at: null, collection_id: null },
      },
      {
        server_seq: 2,
        collection: "listening_sessions",
        doc_id: "ls-1",
        op: "upsert",
        hlc: hlc(1001),
        data: {
          id: "ls-1",
          item_id: "pl-x",
          started_at: 1,
          ended_at: 2,
          from_position: 0,
          to_position: 5,
        },
      },
      { server_seq: 3, collection: "notes", doc_id: "note-1", op: "delete", hlc: hlc(1002) },
    ]
    gateway.pullPages = [{ changes, cursor: 3, has_more: false }]

    const result = await pullAndMerge(deps(gateway, state, apply))

    expect(result.applied).toBe(3)
    expect([...result.changedCollections].sort()).toEqual([
      "listening_sessions",
      "notes",
      "playlist_items",
    ])

    // Each change applied to the right collection, with the server HLC pointer.
    const byCollection = new Map(apply.applied.map((c) => [c.collection, c]))
    expect(byCollection.get("playlist_items")!.doc.deleted).toBe(false)
    expect(byCollection.get("playlist_items")!.serverHlc).toBe(hlc(1000))
    expect(byCollection.get("listening_sessions")!.doc.deleted).toBe(false)
    expect(byCollection.get("notes")!.doc.deleted).toBe(true)

    // Cursor advanced + acknowledged for compaction.
    expect(state.pullCursor).toBe(3)
    expect(state.ackedSeq).toBe(3)
    expect(gateway.ackCalls).toEqual([{ device_id: "dev-1", acked_seq: 3 }])
  })

  it("skips collections the engine does not own (e.g. a future one) — extensible routing", async () => {
    const gateway = new FakeSyncClient()
    const state = new FakeSyncState()
    const apply = new FakeApply()
    gateway.pullPages = [
      {
        changes: [
          {
            server_seq: 1,
            collection: "media_items",
            doc_id: "s1",
            op: "upsert",
            hlc: hlc(1),
            data: {},
          },
        ],
        cursor: 1,
        has_more: false,
      },
    ]

    const result = await pullAndMerge(deps(gateway, state, apply))

    expect(result.applied).toBe(0)
    expect(apply.applied).toHaveLength(0)
    // Cursor still advances past the skipped change so it isn't re-requested.
    expect(state.pullCursor).toBe(1)
  })

  it("merges against the local doc so a newer local note is not clobbered", async () => {
    const gateway = new FakeSyncClient()
    const state = new FakeSyncState()
    const apply = new FakeApply()

    // Local note is NEWER than the incoming remote change.
    apply.setLocal("notes", {
      docId: "note-1",
      hlc: hlc(5000),
      deleted: false,
      data: { id: "note-1", text: "local-newer" },
    })
    gateway.pullPages = [
      {
        changes: [
          {
            server_seq: 1,
            collection: "notes",
            doc_id: "note-1",
            op: "upsert",
            hlc: hlc(2000),
            data: { id: "note-1", text: "remote-older" },
          },
        ],
        cursor: 1,
        has_more: false,
      },
    ]

    await pullAndMerge(deps(gateway, state, apply))

    // LWW kept the local (higher-HLC) version...
    const call = apply.applied[0]!
    expect((call.doc.data as { text: string }).text).toBe("local-newer")
    // ...but the server pointer still advances to the pulled change's HLC (the
    // base for this device's next push of the doc).
    expect(call.serverHlc).toBe(hlc(2000))
  })

  it("paginates until has_more is false", async () => {
    const gateway = new FakeSyncClient()
    const state = new FakeSyncState()
    const apply = new FakeApply()
    gateway.pullPages = [
      {
        changes: [{ server_seq: 1, collection: "notes", doc_id: "n1", op: "delete", hlc: hlc(1) }],
        cursor: 1,
        has_more: true,
      },
      {
        changes: [{ server_seq: 2, collection: "notes", doc_id: "n2", op: "delete", hlc: hlc(2) }],
        cursor: 2,
        has_more: false,
      },
    ]

    const result = await pullAndMerge(deps(gateway, state, apply))

    expect(result.applied).toBe(2)
    expect(state.pullCursor).toBe(2)
    expect(state.ackedSeq).toBe(2)
  })
})

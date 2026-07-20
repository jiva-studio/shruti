import { describe, expect, it } from "vitest"
import type { Change } from "@lib/contracts"
import { pullAndMerge } from "../pullAndMerge.js"
import { isSyncedCollection, mergeChange } from "../mergeRouting.js"
import { FakeApply, FakeSyncClient, FakeSyncState, fakeUnitOfWork, hlc } from "./fakes.js"

function deps(gateway: FakeSyncClient, state: FakeSyncState, apply: FakeApply) {
  return { gateway, syncState: state, apply, unitOfWork: fakeUnitOfWork }
}

const libraryWire = {
  id: "mem-1",
  track_id: "hash-abc",
  status: "ready",
  origin: "private",
  title_raw: "A lecture",
  audio_key: null,
  transcript_key: null,
  duration: 1000,
}

describe("library_items — pull-only routing", () => {
  it("is an owned collection so the engine applies its changes", () => {
    expect(isSyncedCollection("library_items")).toBe(true)
  })

  it("applies a server library_items change and advances the cursor", async () => {
    const gateway = new FakeSyncClient()
    const state = new FakeSyncState()
    const apply = new FakeApply()

    const changes: Change[] = [
      {
        server_seq: 1,
        collection: "library_items",
        doc_id: "mem-1",
        op: "upsert",
        hlc: hlc(1000),
        data: libraryWire,
      },
    ]
    gateway.pullPages = [{ changes, cursor: 1, has_more: false }]

    const result = await pullAndMerge(deps(gateway, state, apply))

    expect(result.applied).toBe(1)
    expect([...result.changedCollections]).toEqual(["library_items"])
    const call = apply.applied[0]!
    expect(call.collection).toBe("library_items")
    expect(call.doc.deleted).toBe(false)
    expect(call.serverHlc).toBe(hlc(1000))
    expect(state.pullCursor).toBe(1)
  })

  it("applies the server version wholesale even when a newer local doc exists (no LWW)", async () => {
    // Unlike notes (last-write-wins), library_items is server-owned: the merge
    // rule ignores the local version, so a stale local row can never shadow the
    // server's authoritative update.
    const local = {
      docId: "mem-1",
      hlc: hlc(5000),
      deleted: false,
      data: { ...libraryWire, status: "processing" },
    }
    const remote = {
      docId: "mem-1",
      hlc: hlc(2000),
      deleted: false,
      data: { ...libraryWire, status: "ready" },
    }

    const merged = mergeChange("library_items", local, remote)
    expect(merged).toBe(remote)
    expect((merged.data as { status: string }).status).toBe("ready")
  })

  it("routes a server-authored removal to a tombstone apply", async () => {
    const gateway = new FakeSyncClient()
    const state = new FakeSyncState()
    const apply = new FakeApply()
    gateway.pullPages = [
      {
        changes: [
          {
            server_seq: 1,
            collection: "library_items",
            doc_id: "mem-1",
            op: "delete",
            hlc: hlc(3000),
          },
        ],
        cursor: 1,
        has_more: false,
      },
    ]

    await pullAndMerge(deps(gateway, state, apply))

    expect(apply.applied[0]!.doc.deleted).toBe(true)
  })
})

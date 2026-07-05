import { describe, expect, it } from "vitest"
import type { PushResponse } from "@lib/contracts"
import { compareHlcString } from "@lib/domain"
import { pushLocal } from "../pushLocal.js"
import {
  FakeApply,
  FakeOutbox,
  FakeSyncClient,
  FakeSyncState,
  fakeUnitOfWork,
  hlc,
} from "./fakes.js"

function deps(gateway: FakeSyncClient, outbox: FakeOutbox, apply: FakeApply, state: FakeSyncState) {
  return { gateway, outbox, apply, syncState: state, unitOfWork: fakeUnitOfWork }
}

describe("pushLocal — base_hlc reconciliation", () => {
  it("fills base_hlc from the last server HLC (empty for a new doc)", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    // note-1 is brand new (no server HLC); track-1 has a known server master.
    apply.setServerHlc("playlist_items", "track-1", hlc(500))
    outbox.seed([
      {
        collection: "notes",
        docId: "note-1",
        op: "upsert",
        data: { id: "note-1", text: "hi" },
        hlc: hlc(1000),
        baseHlc: null,
      },
      {
        collection: "playlist_items",
        docId: "track-1",
        op: "upsert",
        data: { track_id: "track-1", added_at: 1000, archived_at: null, collection_id: null },
        hlc: hlc(1001),
        baseHlc: null,
      },
    ])
    gateway.pushHandler = (req): PushResponse => ({
      applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
      conflicts: [],
    })

    const result = await pushLocal(deps(gateway, outbox, apply, state))

    expect(result.pushed).toBe(2)
    const pushed = gateway.pushRequests[0]!
    expect(pushed.device_id).toBe("dev-1")
    const byDoc = new Map(pushed.changes.map((c) => [c.doc_id, c]))
    expect(byDoc.get("note-1")!.base_hlc).toBe("") // new doc
    expect(byDoc.get("track-1")!.base_hlc).toBe(hlc(500)) // last-seen master

    // Applied rows marked sent; server pointer + pushed-id bookkeeping updated.
    expect(outbox.rows.every((r) => r.sent)).toBe(true)
    expect(await apply.lastServerHlc("notes", "note-1")).toBe(hlc(1000))
    expect(await apply.lastServerHlc("playlist_items", "track-1")).toBe(hlc(1001))
    expect(state.pushedOutboxId).toBe(2)
  })
})

describe("pushLocal — conflict re-merge", () => {
  it("re-merges the master, re-journals with base=master.hlc and a fresh HLC, then converges", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    apply.setServerHlc("notes", "note-1", hlc(400))
    outbox.seed([
      {
        collection: "notes",
        docId: "note-1",
        op: "upsert",
        data: { id: "note-1", text: "local-edit" },
        hlc: hlc(1000),
        baseHlc: null,
      },
    ])

    const masterHlc = hlc(3000)
    gateway.pushHandler = (req, callIndex): PushResponse => {
      if (callIndex === 0) {
        // First push: stale base — server rejects with its master.
        return {
          applied: [],
          conflicts: [
            {
              collection: "notes",
              doc_id: "note-1",
              master: {
                collection: "notes",
                doc_id: "note-1",
                op: "upsert",
                hlc: masterHlc,
                data: { id: "note-1", text: "server-wins" },
              },
            },
          ],
        }
      }
      // Second push (the re-journaled merge): accepted.
      return {
        applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
        conflicts: [],
      }
    }

    const result = await pushLocal(deps(gateway, outbox, apply, state))

    expect(result.conflicts).toBe(1)
    expect(gateway.pushRequests).toHaveLength(2)

    // The re-pushed change carried base = master.hlc and an HLC above master.
    const rePushed = gateway.pushRequests[1]!.changes[0]!
    expect(rePushed.base_hlc).toBe(masterHlc)
    expect(compareHlcString(rePushed.hlc, masterHlc)).toBeGreaterThan(0)

    // LWW resolved to the master (higher HLC) — the local row converged to it.
    const localConverge = apply.applied.at(-1)!
    expect((localConverge.doc.data as { text: string }).text).toBe("server-wins")

    // Everything drained + acknowledged; nothing left pending.
    expect(outbox.rows.every((r) => r.sent)).toBe(true)
    expect(result.changedCollections).toContain("notes")
  })
})

describe("pushLocal — idempotent no-op", () => {
  it("does nothing when the outbox is empty", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    const result = await pushLocal(deps(gateway, outbox, apply, state))

    expect(result).toEqual({ pushed: 0, conflicts: 0, changedCollections: [] })
    expect(gateway.pushRequests).toHaveLength(0)
  })
})

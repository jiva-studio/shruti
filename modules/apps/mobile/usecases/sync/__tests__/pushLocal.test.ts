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

  it("keeps an explicit empty base even when the doc has a recorded master", async () => {
    // A row the anonymous handover re-opened (#1627), or a backfilled one, whose
    // doc got a master from the pull earlier in the SAME cycle. Taking that
    // master as the base would fast-forward the server past its own version;
    // an empty base asks for the conflict instead.
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    apply.setServerHlc("notes", "note-1", hlc(9000))
    outbox.seed([
      {
        collection: "notes",
        docId: "note-1",
        op: "upsert",
        data: { id: "note-1", text: "from the anonymous period" },
        hlc: hlc(1000),
        baseHlc: "",
      },
    ])
    gateway.pushHandler = (req): PushResponse => ({
      applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
      conflicts: [],
    })

    await pushLocal(deps(gateway, outbox, apply, state))

    expect(gateway.pushRequests[0]!.changes[0]!.base_hlc).toBe("")
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

describe("pushLocal — outbox watermark", () => {
  /** One `notes` upsert, so a batch reads as N distinct docs. */
  const note = (n: number) => ({
    collection: "notes",
    docId: `note-${n}`,
    op: "upsert" as const,
    data: { id: `note-${n}`, text: `n${n}` },
    hlc: hlc(1000 + n),
    baseHlc: null,
  })

  const applyAll = (gateway: FakeSyncClient) => {
    gateway.pushHandler = (req): PushResponse => ({
      applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
      conflicts: [],
    })
  }

  it("skips rows retired by the watermark and pushes only what came after", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()
    applyAll(gateway)

    // Rows 1-2 were journaled by the previous identity; the owner guard raised
    // the watermark past them. Row 3 belongs to the account signed in now.
    outbox.seed([note(1), note(2)])
    state.pushedOutboxId = await outbox.latestId()
    outbox.seed([note(3)])

    const result = await pushLocal(deps(gateway, outbox, apply, state))

    expect(result.pushed).toBe(1)
    expect(gateway.pushRequests).toHaveLength(1)
    expect(gateway.pushRequests[0]!.changes.map((c) => c.doc_id)).toEqual(["note-3"])
    // The retired rows stay unsent and unseen — nothing re-reads them.
    expect(outbox.rows.filter((r) => !r.sent).map((r) => r.docId)).toEqual(["note-1", "note-2"])
    expect(state.pushedOutboxId).toBe(3)
  })

  it("pushes nothing when every row predates the watermark", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()
    applyAll(gateway)

    outbox.seed([note(1), note(2)])
    state.pushedOutboxId = await outbox.latestId()

    const result = await pushLocal(deps(gateway, outbox, apply, state))

    expect(result.pushed).toBe(0)
    expect(gateway.pushRequests).toHaveLength(0)
  })

  it("holds the watermark below a row the server left unhandled", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    outbox.seed([note(1), note(2), note(3)])
    // The server acknowledges everything except note-2.
    gateway.pushHandler = (req): PushResponse => ({
      applied: req.changes
        .filter((c) => c.doc_id !== "note-2")
        .map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
      conflicts: [],
    })

    await pushLocal(deps(gateway, outbox, apply, state))

    // Advancing to 3 would retire note-2 unpushed; it must stay retryable.
    expect(state.pushedOutboxId).toBe(1)
    expect(outbox.rows.filter((r) => !r.sent).map((r) => r.docId)).toEqual(["note-2"])

    applyAll(gateway)
    const retry = await pushLocal(deps(gateway, outbox, apply, state))

    expect(retry.pushed).toBe(1)
    expect(gateway.pushRequests[1]!.changes.map((c) => c.doc_id)).toEqual(["note-2"])
  })

  it("keeps draining past a full, conflict-free batch", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()
    applyAll(gateway)

    // A backfill enqueues more than one PUSH_BATCH (200). Stopping on the
    // first conflict-free round would cap the cycle at 200 rows and leave the
    // rest waiting on the 3-minute idle cadence (#1597).
    outbox.seed(Array.from({ length: 250 }, (_, i) => note(i + 1)))

    const result = await pushLocal(deps(gateway, outbox, apply, state))

    expect(result.pushed).toBe(250)
    expect(gateway.pushRequests).toHaveLength(2)
    expect(outbox.rows.every((r) => r.sent)).toBe(true)
  })
})

describe("pushLocal — owner scoping", () => {
  const note = (n: number) => ({
    collection: "notes",
    docId: `note-${n}`,
    op: "upsert" as const,
    data: { id: `note-${n}`, text: `n${n}` },
    hlc: hlc(1000 + n),
    baseHlc: null,
  })

  const applyAll = (gateway: FakeSyncClient) => {
    gateway.pushHandler = (req): PushResponse => ({
      applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
      conflicts: [],
    })
  }

  it("never pushes a deleted account's rows under the identity that replaces it", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()
    applyAll(gateway)

    // user-1 journals a note and a chat message, then deletes the account —
    // the wipe leaves both rows behind, unsent.
    outbox.owner = "user-1"
    outbox.seed([note(1), { ...note(2), collection: "chat_messages" }])
    // The device drops to a fresh anonymous identity and writes its own note.
    outbox.owner = "anon-2"
    outbox.seed([note(3)])

    const result = await pushLocal({ ...deps(gateway, outbox, apply, state), ownerId: "anon-2" })

    expect(result.pushed).toBe(1)
    expect(gateway.pushRequests[0]!.changes.map((c) => c.doc_id)).toEqual(["note-3"])
    expect(outbox.rows.filter((r) => !r.sent).map((r) => r.docId)).toEqual(["note-1", "note-2"])
  })

  it("keeps the new identity's rows pushable when the watermark lands late", async () => {
    // The blocking sequence from #1497's review: a cycle for user-1 is still in
    // flight when the account is deleted, so the engine's owner guard does not
    // run until after anon-2 has already journaled. It then stamps the whole
    // journal's tail as the watermark — which must not retire anon-2's rows.
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()
    applyAll(gateway)

    outbox.owner = "user-1"
    outbox.seed([note(1)])
    outbox.owner = "anon-2"
    outbox.seed([note(2), note(3)])
    state.pushedOutboxId = await outbox.latestId()

    const result = await pushLocal({ ...deps(gateway, outbox, apply, state), ownerId: "anon-2" })

    expect(result.pushed).toBe(2)
    expect(gateway.pushRequests[0]!.changes.map((c) => c.doc_id)).toEqual(["note-2", "note-3"])
  })

  it("pushes rows journaled before the owner stamp existed for whoever owns the device", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()
    applyAll(gateway)

    // Pre-023 rows carry no owner; an un-switched device still pushes them.
    outbox.seed([note(1)])
    outbox.owner = "user-1"
    outbox.seed([note(2)])

    const result = await pushLocal({ ...deps(gateway, outbox, apply, state), ownerId: "user-1" })

    expect(result.pushed).toBe(2)
    expect(gateway.pushRequests[0]!.changes.map((c) => c.doc_id)).toEqual(["note-1", "note-2"])
  })
})

describe("pushLocal — identity changing mid-drain", () => {
  const note = (n: number) => ({
    collection: "notes",
    docId: `note-${n}`,
    op: "upsert" as const,
    data: { id: `note-${n}`, text: `n${n}` },
    hlc: hlc(1000 + n),
    baseHlc: null,
  })

  it("stamps a conflict re-merge with the drain's owner, not whoever is here now", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    outbox.owner = "user-1"
    outbox.seed([note(1)])
    apply.setServerHlc("notes", "note-1", hlc(500))

    // The push round-trips; the account is deleted while it is in flight, so
    // by the time the re-merge is journaled the device belongs to anon-2.
    gateway.pushHandler = (req, i): PushResponse => {
      outbox.owner = "anon-2"
      return i === 0
        ? {
            applied: [],
            conflicts: [
              {
                collection: "notes",
                doc_id: "note-1",
                master: {
                  collection: "notes",
                  doc_id: "note-1",
                  op: "upsert",
                  data: { id: "note-1", text: "server" },
                  hlc: hlc(2000),
                },
              },
            ],
          }
        : {
            applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
            conflicts: [],
          }
    }

    await pushLocal({ ...deps(gateway, outbox, apply, state), ownerId: "user-1" })

    // The merged document is still user-1's — it must never become anon-2's.
    const remerged = outbox.rows.filter((r) => r.hlc !== hlc(1001))
    expect(remerged).toHaveLength(1)
    expect(remerged[0]!.owner).toBe("user-1")
  })

  it("stops draining when the live identity moves mid-cycle", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    outbox.owner = "user-1"
    outbox.seed([note(1)])
    let live = "user-1"
    // Round 1 conflicts, which would normally drive a second round; the
    // anonymous bootstrap lands in between.
    gateway.pushHandler = (req, i): PushResponse => {
      if (i === 0) {
        live = "anon-2"
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
                data: { id: "note-1", text: "server" },
                hlc: hlc(2000),
              },
            },
          ],
        }
      }
      return {
        applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
        conflicts: [],
      }
    }

    await pushLocal({
      ...deps(gateway, outbox, apply, state),
      ownerId: "user-1",
      getLiveOwnerId: () => live,
    })

    // One POST only: the re-merge stays journaled for the next cycle rather
    // than going out under anon-2's bearer token.
    expect(gateway.pushRequests).toHaveLength(1)
    expect(outbox.rows.some((r) => !r.sent && r.owner === "user-1")).toBe(true)
  })

  it("does not start a drain that no longer belongs to the live identity", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    outbox.owner = "user-1"
    outbox.seed([note(1)])

    const result = await pushLocal({
      ...deps(gateway, outbox, apply, state),
      ownerId: "user-1",
      getLiveOwnerId: () => "anon-2",
    })

    expect(result.pushed).toBe(0)
    expect(gateway.pushRequests).toHaveLength(0)
  })

  it("re-checks the identity after reconciling base_hlc, before the request (#1828)", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    outbox.owner = "user-1"
    outbox.seed([note(1)])
    let live: string | null = "user-1"
    // A rejected `/auth/refresh` clears the session while the round is reading
    // each pending row's base_hlc — the gap between the round's owner check and
    // the token the transport resolves inside the request.
    apply.lastServerHlc = async () => {
      live = "anon-2"
      return null
    }

    const result = await pushLocal({
      ...deps(gateway, outbox, apply, state),
      ownerId: "user-1",
      getLiveOwnerId: () => live,
    })

    // Nothing left the device, so nothing was marked sent and nothing had its
    // doc HLC pointer rewritten: the batch is re-pushable under the real owner.
    expect(result.pushed).toBe(0)
    expect(gateway.pushRequests).toHaveLength(0)
    expect(outbox.rows.every((r) => !r.sent)).toBe(true)
    expect(state.pushedOutboxId).toBe(0)
  })
})

describe("pushLocal — watermark write-back", () => {
  it("keeps a watermark raised during the push instead of the pre-network value", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()

    outbox.seed([
      {
        collection: "notes",
        docId: "note-1",
        op: "upsert",
        data: { id: "note-1", text: "hi" },
        hlc: hlc(1000),
        baseHlc: null,
      },
    ])
    // The owner guard stamps a tail watermark while the POST is in flight.
    gateway.pushHandler = (req): PushResponse => {
      state.pushedOutboxId = 99
      return {
        applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
        conflicts: [],
      }
    }

    await pushLocal(deps(gateway, outbox, apply, state))

    // Writing back the round's own maxSentId (1) would rewind past 99 and
    // un-retire every row the guard just retired.
    expect(state.pushedOutboxId).toBe(99)
  })
})

describe("pushLocal — journal compaction", () => {
  /** One `notes` upsert for `docId`, so a batch reads as N revisions. */
  const upsert = (docId: string, physical: number) => ({
    collection: "notes",
    docId,
    op: "upsert" as const,
    data: { id: docId, text: `t${physical}` },
    hlc: hlc(physical),
    baseHlc: null,
  })

  it("drops the acknowledged revisions its own round superseded (#1798)", async () => {
    const gateway = new FakeSyncClient()
    const outbox = new FakeOutbox()
    const apply = new FakeApply()
    const state = new FakeSyncState()
    gateway.pushHandler = (req): PushResponse => ({
      applied: req.changes.map((c) => ({ collection: c.collection, doc_id: c.doc_id })),
      conflicts: [],
    })

    // note-1 was edited twice before either edit reached the server.
    outbox.seed([
      upsert("note-1", 1000),
      upsert("note-1", 1001),
      upsert("note-2", 1002),
      upsert("note-3", 1003),
    ])

    await pushLocal(deps(gateway, outbox, apply, state))

    // Row 1 goes; note-1 keeps its newest row, note-2 its only one, and the
    // tail stays where `latestHlc` / `latestId` read it.
    expect(outbox.rows.map((r) => r.id)).toEqual([2, 3, 4])
    expect(await outbox.latestId()).toBe(4)
    expect(await outbox.latestHlc()).toBe(hlc(1003))
  })
})

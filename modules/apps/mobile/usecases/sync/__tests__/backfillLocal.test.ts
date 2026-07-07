import { describe, expect, it } from "vitest"
import { compareHlcString } from "@lib/domain"
import type { BackfillCandidate } from "@lib/domain/ports/syncBackfillRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { backfillLocal } from "../backfillLocal.js"
import { FakeBackfill, FakeOutbox, FakeSyncState, fakeUnitOfWork, hlc } from "./fakes.js"

/** Canonical pre-sync rows in the three synced collections, shaped exactly as
 *  the sync-journal decorator would write them into `outbox.data`. */
const NOTE: BackfillCandidate = {
  collection: "notes",
  docId: "note_1",
  data: {
    id: "note_1",
    track_id: "trk_1",
    text: "before sync",
    time_start: 10,
    time_end: 20,
    created_at: 1000,
    meta: null,
  },
}
const PLAYLIST: BackfillCandidate = {
  collection: "playlist_items",
  docId: "trk_2",
  data: { id: "pl_1", track_id: "trk_2", added_at: 1500, archived_at: null, collection_id: null },
}
const SESSION: BackfillCandidate = {
  collection: "listening_sessions",
  docId: "ls_1",
  data: {
    id: "ls_1",
    item_id: "pl_1",
    // Resolved from the playlist item via the backfill JOIN — a backfilled
    // session carries its track attribution just like a journaled one.
    track_id: "trk_2",
    started_at: 900,
    ended_at: 950,
    from_position: 0,
    to_position: 42,
  },
}

function deps() {
  const backfill = new FakeBackfill()
  const outbox = new FakeOutbox()
  const syncState = new FakeSyncState()
  backfill.outbox = outbox // model the adapter's anti-join (idempotency guard)
  return { backfill, outbox, syncState, unitOfWork: fakeUnitOfWork }
}

describe("backfillLocal", () => {
  it("enqueues each un-journaled candidate as an upsert with empty base_hlc, snapshot preserved", async () => {
    const d = deps()
    d.backfill.candidates = [NOTE, PLAYLIST, SESSION]

    const res = await backfillLocal(d)

    expect(res.enqueued).toBe(3)
    expect(new Set(res.collections)).toEqual(
      new Set(["notes", "playlist_items", "listening_sessions"])
    )

    const rows = await d.outbox.listPending()
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.op).toBe("upsert")
      expect(row.baseHlc).toBe("")
    }
    // The wire snapshot is passed through untouched — byte-identical to a
    // journaled row.
    const byDoc = new Map(rows.map((r) => [`${r.collection} ${r.docId}`, r]))
    expect(byDoc.get("notes note_1")!.data).toEqual(NOTE.data)
    expect(byDoc.get("playlist_items trk_2")!.data).toEqual(PLAYLIST.data)
    expect(byDoc.get("listening_sessions ls_1")!.data).toEqual(SESSION.data)
  })

  it("stamps strictly monotonic HLCs seeded from the outbox tail", async () => {
    const d = deps()
    // A prior journaled change already sits at the tail; backfilled stamps must
    // all be strictly greater and strictly increasing among themselves.
    const tail = hlc(5_000, 0, "dev-1")
    d.outbox.seed([
      { collection: "notes", docId: "note_0", op: "upsert", data: {}, hlc: tail, baseHlc: null },
    ])
    d.backfill.candidates = [NOTE, PLAYLIST, SESSION]

    await backfillLocal(d)

    const appended = (await d.outbox.listPending()).filter((r) => r.docId !== "note_0")
    expect(appended).toHaveLength(3)
    let prev = tail
    for (const row of appended) {
      expect(compareHlcString(row.hlc, prev)).toBeGreaterThan(0)
      prev = row.hlc
    }
  })

  it("is idempotent: a second run enqueues nothing (candidates now have outbox rows)", async () => {
    const d = deps()
    d.backfill.candidates = [NOTE, PLAYLIST, SESSION]

    const first = await backfillLocal(d)
    expect(first.enqueued).toBe(3)

    const second = await backfillLocal(d)
    expect(second.enqueued).toBe(0)
    expect(second.collections).toEqual([])
    // No double-enqueue: still exactly the three rows from the first pass.
    expect(await d.outbox.listPending()).toHaveLength(3)
  })

  it("no-ops on an empty candidate set (nothing to backfill)", async () => {
    const d = deps()
    d.backfill.candidates = []

    const res = await backfillLocal(d)

    expect(res.enqueued).toBe(0)
    expect(await d.outbox.listPending()).toHaveLength(0)
  })

  it("runs the whole pass inside a single unit-of-work", async () => {
    const d = deps()
    d.backfill.candidates = [NOTE, PLAYLIST]
    let runs = 0
    const unitOfWork: IUnitOfWork = {
      run: (fn) => {
        runs++
        return fn()
      },
    }

    await backfillLocal({ ...d, unitOfWork })

    expect(runs).toBe(1)
  })
})

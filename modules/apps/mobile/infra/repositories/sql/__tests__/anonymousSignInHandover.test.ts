import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type {
  Change,
  Conflict,
  ISyncClient,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  Ref,
} from "@lib/contracts"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { adoptAnonymousChanges, backfillLocal, runSync } from "@usecases/sync/index.js"
import { createInMemoryTestDatabase } from "./testDb.js"
import { createSqlOutboxRepository } from "../outboxRepository.sql.js"
import { createSqlSyncApplyRepository } from "../syncApplyRepository.sql.js"
import { createSqlSyncBackfillRepository } from "../syncBackfillRepository.sql.js"

/**
 * End-to-end test for #1627: a device used anonymously signs in to an account
 * the human ALREADY had, so `userId` flips to a different id. Everything from
 * the anonymous period has to end up on the new account — it was on screen the
 * whole time — without overwriting what that account already holds.
 *
 * Real SQL adapters over an in-memory `user.db` on one side, a fake `profile`
 * service that reproduces the Go push semantics (idempotent exact-HLC retry,
 * conflict on a stale base, otherwise apply) on the other, driven through the
 * real use cases. The failure this guards is silent: without the handover
 * every assertion below still leaves the local rows on screen, and the new
 * account's change log simply never hears about them.
 */

/* -------------------------------------------------------------------------- */
/*                          fake `profile` service                             */
/* -------------------------------------------------------------------------- */

interface Account {
  docs: Map<string, Change>
  log: Change[]
}

class FakeProfileService {
  private accounts = new Map<string, Account>()
  private seq = 0
  /** Which account the client's bearer token resolves to right now. */
  account = "anon-1"
  /** Applies the batch, then fails the response — a push interrupted between
   *  the server commit and the client seeing it. */
  failNextPushAfterApply = false

  private current(): Account {
    let a = this.accounts.get(this.account)
    if (!a) {
      a = { docs: new Map(), log: [] }
      this.accounts.set(this.account, a)
    }
    return a
  }

  private key(collection: string, docId: string): string {
    return `${collection} ${docId}`
  }

  /** Seed a document as though another device had written it. */
  seed(account: string, change: Omit<Change, "server_seq">): void {
    const prev = this.account
    this.account = account
    const a = this.current()
    const stored = { ...change, server_seq: ++this.seq }
    a.docs.set(this.key(change.collection, change.doc_id), stored)
    a.log.push(stored)
    this.account = prev
  }

  master(account: string, collection: string, docId: string): Change | undefined {
    return this.accounts.get(account)?.docs.get(this.key(collection, docId))
  }

  log(account: string): readonly Change[] {
    return this.accounts.get(account)?.log ?? []
  }

  docIds(account: string, collection: string): string[] {
    return [...(this.accounts.get(account)?.docs.values() ?? [])]
      .filter((c) => c.collection === collection && c.op !== "delete")
      .map((c) => c.doc_id)
      .sort()
  }

  client(): ISyncClient {
    return {
      pull: async (req: PullRequest): Promise<PullResponse> => {
        const a = this.current()
        const changes = a.log.filter((c) => (c.server_seq ?? 0) > req.cursor)
        return {
          changes,
          cursor: changes.length > 0 ? (changes[changes.length - 1]!.server_seq ?? 0) : req.cursor,
          has_more: false,
        }
      },
      push: async (req: PushRequest): Promise<PushResponse> => {
        const a = this.current()
        const applied: Ref[] = []
        const conflicts: Conflict[] = []
        for (const it of req.changes) {
          const key = this.key(it.collection, it.doc_id)
          const master = a.docs.get(key)
          if (master && master.hlc === it.hlc) {
            applied.push({ collection: it.collection, doc_id: it.doc_id })
            continue
          }
          if (master && (it.base_hlc ?? "") !== master.hlc) {
            conflicts.push({ collection: it.collection, doc_id: it.doc_id, master })
            continue
          }
          const stored: Change = {
            collection: it.collection,
            doc_id: it.doc_id,
            op: it.op,
            data: it.data,
            hlc: it.hlc,
            server_seq: ++this.seq,
          }
          a.docs.set(key, stored)
          a.log.push(stored)
          applied.push({ collection: it.collection, doc_id: it.doc_id })
        }
        if (this.failNextPushAfterApply) {
          this.failNextPushAfterApply = false
          throw new Error("network dropped after commit")
        }
        return { applied, conflicts }
      },
      ackCursor: async (): Promise<void> => {},
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  harness                                    */
/* -------------------------------------------------------------------------- */

const fakeUnitOfWork: IUnitOfWork = { run: <T>(fn: () => Promise<T>) => fn() }

class MemorySyncState implements ISyncStateRepository {
  pullCursor = 0
  ackedSeq = 0
  pushedOutboxId = 0
  getDeviceId = async () => "dev-1"
  getPullCursor = async () => this.pullCursor
  setPullCursor = async (c: number) => {
    this.pullCursor = c
  }
  getAckedSeq = async () => this.ackedSeq
  setAckedSeq = async (s: number) => {
    this.ackedSeq = s
  }
  getPushedOutboxId = async () => this.pushedOutboxId
  setPushedOutboxId = async (id: number) => {
    this.pushedOutboxId = id
  }
}

async function applySchema(db: IDatabase): Promise<void> {
  await db.execute(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, track_id TEXT NOT NULL, text TEXT NOT NULL,
    time_start INTEGER NOT NULL, time_end INTEGER NOT NULL,
    created_at INTEGER NOT NULL, meta TEXT
  )`)
  await db.execute(`CREATE TABLE playlist_items (
    id TEXT PRIMARY KEY, track_id TEXT NOT NULL, added_at INTEGER NOT NULL,
    archived_at INTEGER, collection_id TEXT
  )`)
  await db.execute(`CREATE TABLE listening_sessions (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL, from_position INTEGER NOT NULL, to_position INTEGER NOT NULL
  )`)
  await db.execute(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, doc_id TEXT NOT NULL,
    op TEXT NOT NULL, data TEXT, hlc TEXT NOT NULL, base_hlc TEXT,
    created_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, owner_id TEXT
  )`)
  await db.execute(`CREATE TABLE sync_doc_hlc (
    collection TEXT NOT NULL, doc_id TEXT NOT NULL, server_hlc TEXT NOT NULL,
    PRIMARY KEY (collection, doc_id)
  )`)
}

const ANON = "anon-1"
const ACCOUNT = "user-b"
/** B wrote this from another device, ahead of the anonymous device's clock
 *  (the backfill stamps `Date.now()`, so the year has to be well past it). */
const B_HLC = "004102444800000:00000:dev-other"

describe("anonymous sign-in handover (#1627)", () => {
  let db: IDatabase
  let server: FakeProfileService
  let syncState: MemorySyncState
  let owner: string | null

  const repos = () => ({
    outbox: createSqlOutboxRepository(db, () => owner),
    apply: createSqlSyncApplyRepository(db),
    backfill: createSqlSyncBackfillRepository(db, () => false),
  })

  const cycle = (ownerId: string) => {
    const r = repos()
    return runSync({
      gateway: server.client(),
      outbox: r.outbox,
      apply: r.apply,
      syncState,
      unitOfWork: fakeUnitOfWork,
      ownerId,
    })
  }

  const journal = async (ownerId: string) => {
    const r = repos()
    return backfillLocal({
      backfill: r.backfill,
      outbox: r.outbox,
      apply: r.apply,
      syncState,
      unitOfWork: fakeUnitOfWork,
      ownerId,
    })
  }

  const noteText = async (id: string): Promise<string | undefined> =>
    (await db.query<{ text: string }>("SELECT text FROM notes WHERE id = ?", [id]))[0]?.text

  /** The anonymous week: three documents written, journaled and uploaded under
   *  the anonymous account, plus one written just before the sign-in that never
   *  made it out. */
  async function anonymousPeriod(): Promise<void> {
    owner = ANON
    server.account = ANON
    await db.execute(
      `INSERT INTO notes (id, track_id, text, time_start, time_end, created_at, meta)
       VALUES ('note_a', 'trk_1', 'written while anonymous', 0, 5, 100, NULL),
              ('note_shared', 'trk_1', 'stale local copy', 0, 5, 100, NULL)`
    )
    await db.execute(
      `INSERT INTO playlist_items (id, track_id, added_at, archived_at, collection_id)
       VALUES ('pl_1', 'trk_shared', 500, NULL, NULL)`
    )
    await db.execute(
      `INSERT INTO listening_sessions (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_a', 'pl_1', 600, 900, 0, 300)`
    )
    await journal(ANON)
    await cycle(ANON)

    // One more note, journaled but never pushed — the sign-in interrupts it.
    await db.execute(
      `INSERT INTO notes (id, track_id, text, time_start, time_end, created_at, meta)
       VALUES ('note_late', 'trk_1', 'seconds before signing in', 0, 5, 200, NULL)`
    )
    await journal(ANON)
  }

  /** What `useSyncEngine` does the moment it notices anonymous → a different
   *  account: hand the journal over, then re-pull the new account from 0. */
  async function signIn(): Promise<void> {
    owner = ACCOUNT
    server.account = ACCOUNT
    const r = repos()
    await adoptAnonymousChanges({
      outbox: r.outbox,
      apply: r.apply,
      unitOfWork: fakeUnitOfWork,
      fromOwnerId: ANON,
      toOwnerId: ACCOUNT,
    })
    syncState.pullCursor = 0
    syncState.ackedSeq = 0
  }

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    server = new FakeProfileService()
    syncState = new MemorySyncState()
    owner = null

    // The account the human already had, populated from another device.
    server.seed(ACCOUNT, {
      collection: "notes",
      doc_id: "note_b",
      op: "upsert",
      data: {
        id: "note_b",
        track_id: "trk_9",
        text: "written on the old phone",
        time_start: 0,
        time_end: 5,
        created_at: 50,
        meta: null,
      },
      hlc: B_HLC,
    })
    server.seed(ACCOUNT, {
      collection: "notes",
      doc_id: "note_shared",
      op: "upsert",
      data: {
        id: "note_shared",
        track_id: "trk_1",
        text: "newer, from the other device",
        time_start: 0,
        time_end: 5,
        created_at: 100,
        meta: null,
      },
      hlc: B_HLC,
    })
    // Same track, removed from the library under the pre-existing account.
    server.seed(ACCOUNT, {
      collection: "playlist_items",
      doc_id: "trk_shared",
      op: "upsert",
      data: { track_id: "trk_shared", added_at: 1000, archived_at: 2000, collection_id: null },
      hlc: B_HLC,
    })
  })

  it("uploads the whole anonymous period under the account that signed in", async () => {
    await anonymousPeriod()
    // Nothing of it is on the pre-existing account yet.
    expect(server.docIds(ACCOUNT, "notes")).toEqual(["note_b", "note_shared"])

    await signIn()
    await cycle(ACCOUNT)

    expect(server.docIds(ACCOUNT, "notes")).toEqual([
      "note_a",
      "note_b",
      "note_late",
      "note_shared",
    ])
    expect(server.docIds(ACCOUNT, "listening_sessions")).toEqual(["ls_a"])
    expect(server.master(ACCOUNT, "notes", "note_a")).toMatchObject({ op: "upsert" })
  })

  it("without the handover the same data never reaches the account", async () => {
    await anonymousPeriod()
    // Same transition, minus the re-attribution: the push scopes to the new
    // owner and the anonymous rows are simply unreadable.
    owner = ACCOUNT
    server.account = ACCOUNT
    syncState.pullCursor = 0
    syncState.ackedSeq = 0

    await cycle(ACCOUNT)

    expect(server.docIds(ACCOUNT, "notes")).toEqual(["note_b", "note_shared"])
    expect(server.docIds(ACCOUNT, "listening_sessions")).toEqual([])
  })

  it("pulls the pre-existing account's own data down to the device", async () => {
    await anonymousPeriod()
    await signIn()
    await cycle(ACCOUNT)

    expect(await noteText("note_b")).toBe("written on the old phone")
  })

  it("lets the newer version win when both identities hold the same document", async () => {
    await anonymousPeriod()
    await signIn()
    await cycle(ACCOUNT)

    // The anonymous copy is older, so it must NOT overwrite the account's —
    // on the server or on the device.
    expect(server.master(ACCOUNT, "notes", "note_shared")!.data).toMatchObject({
      text: "newer, from the other device",
    })
    expect(await noteText("note_shared")).toBe("newer, from the other device")
  })

  it("merges a colliding playlist item by its add-wins rule, not by overwrite", async () => {
    await anonymousPeriod()
    await signIn()
    await cycle(ACCOUNT)

    // A blind fast-forward would have replaced the account's master with the
    // anonymous snapshot (added_at 500, archived_at null).
    expect(server.master(ACCOUNT, "playlist_items", "trk_shared")!.data).toMatchObject({
      added_at: 1000,
      archived_at: 2000,
    })
  })

  it("leaves the abandoned anonymous account untouched", async () => {
    await anonymousPeriod()
    await signIn()
    await cycle(ACCOUNT)

    expect(server.docIds(ANON, "notes")).toEqual(["note_a", "note_shared"])
  })

  it("resumes a handover interrupted mid-push without duplicating or losing anything", async () => {
    await anonymousPeriod()
    await signIn()

    // The server commits the batch, then the connection drops.
    server.failNextPushAfterApply = true
    await expect(cycle(ACCOUNT)).rejects.toThrow("network dropped")

    // Relaunch: the marker was never written, so the engine re-detects the
    // transition and runs the handover again before the next cycle.
    const r = repos()
    const again = await adoptAnonymousChanges({
      outbox: r.outbox,
      apply: r.apply,
      unitOfWork: fakeUnitOfWork,
      fromOwnerId: ANON,
      toOwnerId: ACCOUNT,
    })
    expect(again.docs).toBe(0)

    syncState.pullCursor = 0
    syncState.ackedSeq = 0
    await cycle(ACCOUNT)

    expect(server.docIds(ACCOUNT, "notes")).toEqual([
      "note_a",
      "note_b",
      "note_late",
      "note_shared",
    ])
    // The retried rows carried their original HLCs, so the server absorbed
    // them as exact retries instead of appending a second version.
    const appended = server.log(ACCOUNT).filter((c) => c.doc_id === "note_a")
    expect(appended).toHaveLength(1)
    expect(await noteText("note_shared")).toBe("newer, from the other device")
  })

  it("drains everything the handover re-opened, leaving no pending rows", async () => {
    await anonymousPeriod()
    await signIn()
    await cycle(ACCOUNT)

    const pending = await repos().outbox.listPending(undefined, { ownerId: ACCOUNT })
    expect(pending).toEqual([])
  })
})

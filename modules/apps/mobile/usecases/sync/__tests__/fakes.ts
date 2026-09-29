import { hlcToString } from "@lib/domain"
import type {
  ISyncClient,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  CursorRequest,
} from "@lib/contracts"
import type {
  IOutboxRepository,
  NewOutboxEntry,
  OutboxEntry,
  OutboxPrune,
  OutboxScope,
  OutboxReattribution,
} from "@lib/domain/ports/outboxRepository.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type {
  BackfillCandidate,
  ISyncBackfillRepository,
} from "@lib/domain/ports/syncBackfillRepository.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { IClock } from "@lib/domain/ports/clock.js"
import type { SyncDoc, SyncDocRef } from "@lib/domain"

/** Build a wire HLC string with explicit components (mirrors merge.test.ts). */
export const hlc = (physical: number, counter = 0, deviceId = "a"): string =>
  hlcToString({ physical, counter, deviceId })

/** No-op unit-of-work: runs the callback inline (tests need no real tx). */
export const fakeUnitOfWork: IUnitOfWork = {
  run: <T>(fn: () => Promise<T>) => fn(),
}

/** The real wall clock: these tests assert HLC order, not particular stamps. */
export const wallClock: IClock = { now: () => Date.now() }

/** In-memory {@link ISyncStateRepository}. */
export class FakeSyncState implements ISyncStateRepository {
  deviceId = "dev-1"
  pullCursor = 0
  ackedSeq = 0
  pushedOutboxId = 0

  getDeviceId = async () => this.deviceId
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

interface StoredOutbox extends OutboxEntry {
  sent: boolean
  owner: string | null
  baseHlc: string | null
}

/** In-memory {@link IOutboxRepository}. */
export class FakeOutbox implements IOutboxRepository {
  rows: StoredOutbox[] = []
  /** The account journaling right now — stamped on seeded + appended rows,
   *  mirroring the adapter's `getOwnerId`. `null` writes unowned rows (what a
   *  pre-023 journal holds). */
  owner: string | null = null
  private nextId = 1

  seed(entries: Omit<OutboxEntry, "id">[]): void {
    for (const e of entries)
      this.rows.push({ ...e, id: this.nextId++, sent: false, owner: this.owner })
  }

  listPending = async (limit?: number, scope?: OutboxScope): Promise<readonly OutboxEntry[]> => {
    const ownerId = scope?.ownerId ?? null
    const afterId = scope?.afterId ?? 0
    const pending = this.rows
      .filter((r) => !r.sent && (r.owner !== null ? r.owner === ownerId : r.id > afterId))
      .sort((a, b) => a.id - b.id)
    const sliced = limit === undefined ? pending : pending.slice(0, limit)
    return sliced.map(
      (r): OutboxEntry => ({
        id: r.id,
        collection: r.collection,
        docId: r.docId,
        op: r.op,
        data: r.data,
        hlc: r.hlc,
        baseHlc: r.baseHlc,
      })
    )
  }
  markSent = async (ids: readonly number[]): Promise<void> => {
    const set = new Set(ids)
    for (const r of this.rows) if (set.has(r.id)) r.sent = true
  }
  /** Mirrors the adapter: a scoped document's acknowledged rows go once a
   *  newer row for the same document exists — the newest one always stays. */
  prune = async (scope: OutboxPrune): Promise<void> => {
    if (scope.watermark <= 0 || scope.docs.length === 0) return
    const key = (collection: string, docId: string) => `${collection} ${docId}`
    const scoped = new Set(scope.docs.map((d) => key(d.collection, d.docId)))
    const newest = new Map<string, number>()
    for (const r of this.rows) {
      const k = key(r.collection, r.docId)
      if (r.id > (newest.get(k) ?? 0)) newest.set(k, r.id)
    }
    this.rows = this.rows.filter((r) => {
      const k = key(r.collection, r.docId)
      return !(r.sent && r.id < scope.watermark && scoped.has(k) && r.id < newest.get(k)!)
    })
  }
  append = async (entry: NewOutboxEntry): Promise<void> => {
    // Mirrors the adapter: an explicit owner on the entry wins over the
    // provider's "whoever is here now".
    const owner = entry.ownerId !== undefined ? entry.ownerId : this.owner
    this.rows.push({ ...entry, id: this.nextId++, sent: false, owner })
  }
  reattribute = async (scope: OutboxReattribution): Promise<readonly SyncDocRef[]> => {
    if (scope.fromOwnerId === scope.toOwnerId) return []
    const inScope = this.rows.filter((r) =>
      r.owner !== null ? r.owner === scope.fromOwnerId : r.id > scope.unownedAfterId
    )
    const refs = new Map<string, SyncDocRef>()
    for (const r of inScope) {
      refs.set(`${r.collection} ${r.docId}`, { collection: r.collection, docId: r.docId })
      r.owner = scope.toOwnerId
      r.sent = false
      r.baseHlc = ""
    }
    return [...refs.values()]
  }
  latestHlc = async (): Promise<string | null> => {
    if (this.rows.length === 0) return null
    return this.rows.reduce((a, b) => (a.id > b.id ? a : b)).hlc
  }
  latestId = async (): Promise<number> => {
    if (this.rows.length === 0) return 0
    return this.rows.reduce((a, b) => (a.id > b.id ? a : b)).id
  }
  clearAll = async (): Promise<void> => {
    this.rows = []
  }
}

export interface ApplyRemoteCall {
  collection: string
  doc: SyncDoc<unknown>
  serverHlc: string
}

/** In-memory {@link ISyncApplyRepository} — records applies + server HLCs. */
export class FakeApply implements ISyncApplyRepository {
  /** Preloaded local docs, keyed `collection\x00docId`. */
  local = new Map<string, SyncDoc<unknown>>()
  serverHlc = new Map<string, string>()
  applied: ApplyRemoteCall[] = []

  private key(collection: string, docId: string): string {
    return `${collection}\x00${docId}`
  }

  setLocal(collection: string, doc: SyncDoc<unknown>): void {
    this.local.set(this.key(collection, doc.docId), doc)
  }
  setServerHlc(collection: string, docId: string, h: string): void {
    this.serverHlc.set(this.key(collection, docId), h)
  }

  getLocalDoc = async (collection: string, docId: string): Promise<SyncDoc<unknown> | null> =>
    this.local.get(this.key(collection, docId)) ?? null

  applyRemote = async (
    collection: string,
    doc: SyncDoc<unknown>,
    serverHlc: string
  ): Promise<void> => {
    this.applied.push({ collection, doc, serverHlc })
    this.serverHlc.set(this.key(collection, doc.docId), serverHlc)
    if (doc.deleted) this.local.delete(this.key(collection, doc.docId))
    else this.local.set(this.key(collection, doc.docId), doc)
  }

  lastServerHlc = async (collection: string, docId: string): Promise<string | null> =>
    this.serverHlc.get(this.key(collection, docId)) ?? null

  latestServerHlc = async (): Promise<string | null> =>
    [...this.serverHlc.values()].reduce<string | null>(
      (best, h) => (best === null || h > best ? h : best),
      null
    )

  recordServerHlc = async (collection: string, docId: string, h: string): Promise<void> => {
    this.serverHlc.set(this.key(collection, docId), h)
  }

  forgetDocHlcs = async (refs: readonly SyncDocRef[]): Promise<void> => {
    for (const r of refs) this.serverHlc.delete(this.key(r.collection, r.docId))
  }

  clearDocHlcs = async (): Promise<void> => {
    this.serverHlc.clear()
  }
}

/** In-memory {@link ISyncBackfillRepository}. Returns the seeded candidates,
 *  minus any that already have an outbox row — modelling the real adapter's
 *  `NOT EXISTS` anti-join, which is the backfill's idempotency guard. */
export class FakeBackfill implements ISyncBackfillRepository {
  candidates: BackfillCandidate[] = []
  scans = 0
  /** When set, a candidate already present in this outbox is not returned. */
  outbox?: FakeOutbox

  listUnsynced = async (): Promise<readonly BackfillCandidate[]> => {
    this.scans++
    if (!this.outbox) return this.candidates
    const seen = new Set(this.outbox.rows.map((r) => `${r.collection} ${r.docId}`))
    return this.candidates.filter((c) => !seen.has(`${c.collection} ${c.docId}`))
  }
}

/** Programmable {@link ISyncClient}: queued pull pages, a push handler, and
 *  recorded ack calls. */
export class FakeSyncClient implements ISyncClient {
  pullPages: PullResponse[] = []
  /** Cursors the engine asked for, in order — a test that replaces `pull` with
   *  a cursor-respecting log asserts the rewind through this. */
  pullRequests: PullRequest[] = []
  pushRequests: PushRequest[] = []
  ackCalls: CursorRequest[] = []
  pushHandler: (req: PushRequest, callIndex: number) => PushResponse = () => ({
    applied: [],
    conflicts: [],
  })
  /** Ack outcome per call — throw to model a non-2xx `/profile/sync/cursor`. */
  ackHandler: (req: CursorRequest, callIndex: number) => void = () => undefined
  private pullIndex = 0
  private pushIndex = 0
  private ackIndex = 0

  pull = async (req: PullRequest): Promise<PullResponse> => {
    this.pullRequests.push(req)
    const page = this.pullPages[this.pullIndex] ?? { changes: [], cursor: 0, has_more: false }
    this.pullIndex++
    return page
  }
  push = async (req: PushRequest): Promise<PushResponse> => {
    this.pushRequests.push(req)
    return this.pushHandler(req, this.pushIndex++)
  }
  ackCursor = async (req: CursorRequest): Promise<void> => {
    this.ackCalls.push(req)
    this.ackHandler(req, this.ackIndex++)
  }
}

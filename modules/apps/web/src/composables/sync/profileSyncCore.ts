/**
 * Pure engine for the web profile-sync (chat sessions + messages, two-way).
 *
 * No Vue, no fetch, no localStorage — every function is a deterministic
 * transform over a plain {@link SyncState}, so the whole conflict / outbox /
 * HLC machinery is unit-tested without a live server. The composable
 * (`useProfileSync`) owns IO: it persists the state, calls the HTTP client,
 * and applies the returned merge plan to the chat history.
 *
 * Model (the mobile engine's, adapted to a localStorage cache; the HLC, the
 * per-collection merge rules and the push row are the ones mobile uses):
 *  - every local change is stamped with an HLC and queued in `outbox`;
 *  - `buildPushItems` ships the outbox with each doc's last-seen server HLC
 *    as `base_hlc` (optimistic concurrency);
 *  - `applyPushResponse` clears applied writes and resolves `conflicts` by
 *    last-write-wins on the HLC (chat is LWW per the domain merge rules);
 *  - `reducePull` folds a pulled change page into a merge plan and advances
 *    each doc's base HLC.
 *
 * `diffOutbox` derives the change set from a snapshot of the local chat
 * history, so callers never hand-build changes: it enqueues new sessions /
 * messages, re-enqueues a renamed / grown session, and tombstones a session
 * that vanished locally — coalescing against whatever is already queued.
 */

import { compareHlcString, nextHlcString } from "@lib/domain/sync/hlc.js"
import type { Change, PushItem, PushResponse, PullResponse } from "@lib/contracts"
import {
  changeToDoc,
  isSyncedCollection,
  mergeChange,
  pendingToDoc,
} from "@lib/sync/mergeRouting.js"
import { toPushItem } from "@lib/sync/pushItem.js"
import {
  messageToWireData,
  sessionToWireData,
  wireDataToMessage,
  type ChatMessageWireData,
} from "./canonicalMessage"
import type { SerializedMsg } from "../useChatHistory"

export type SyncCollection = "chat_sessions" | "chat_messages"

export interface OutboxEntry {
  collection: SyncCollection
  doc_id: string
  op: "upsert" | "delete"
  /** Wire `data` for an upsert; null on a delete tombstone. */
  data: unknown | null
  hlc: string
}

export interface SyncState {
  /** Stable per-surface device id — the HLC tiebreak and push writer. */
  deviceId: string
  /** Highest HLC this surface has issued or observed (`null` before any). */
  lastHlc: string | null
  /** Pull high-water mark (server `global_seq`). */
  cursor: number
  /** `${collection}:${doc_id}` → last-seen server HLC, the `base_hlc` source. */
  docHlc: Record<string, string>
  /** session id → last-enqueued signature, so an unchanged session is not
   *  re-pushed every persist. */
  sessionSig: Record<string, string>
  /** Pending local changes not yet acknowledged by the server. */
  outbox: OutboxEntry[]
}

/** A chat as the local history holds it (the sync snapshot unit). */
export interface SnapshotChat {
  id: string
  title: string | null
  updatedAt: number
  createdAt?: number
  trackId?: string | null
  messages: SerializedMsg[]
}

/** What `reducePull` / `applyPushResponse` ask the caller to apply to the
 *  local chat history. */
export interface MergePlan {
  sessionUpserts: {
    id: string
    title: string | null
    updatedAt: number
    createdAt: number
    trackId: string | null
  }[]
  messageUpserts: { sessionId: string; msg: SerializedMsg }[]
  sessionDeletes: string[]
}

const EMPTY_PLAN = (): MergePlan => ({ sessionUpserts: [], messageUpserts: [], sessionDeletes: [] })

export function docKey(collection: string, docId: string): string {
  return `${collection}:${docId}`
}

export function newState(deviceId: string): SyncState {
  return {
    deviceId,
    lastHlc: null,
    cursor: 0,
    docHlc: {},
    sessionSig: {},
    outbox: [],
  }
}

function sessionSignature(chat: SnapshotChat): string {
  return `${chat.title ?? ""}\u0000${chat.updatedAt}\u0000${chat.messages.length}`
}

/** Issue the next monotonic HLC, advancing `state.lastHlc` in place. */
function issueHlc(state: SyncState, now: number): string {
  state.lastHlc = nextHlcString(state.deviceId, state.lastHlc || null, now)
  return state.lastHlc
}

function outboxIndex(state: SyncState, collection: string, docId: string): number {
  return state.outbox.findIndex((e) => e.collection === collection && e.doc_id === docId)
}

function enqueueUpsert(
  state: SyncState,
  collection: SyncCollection,
  docId: string,
  data: unknown,
  now: number
): void {
  const idx = outboxIndex(state, collection, docId)
  const entry: OutboxEntry = {
    collection,
    doc_id: docId,
    op: "upsert",
    data,
    hlc: issueHlc(state, now),
  }
  if (idx >= 0) state.outbox[idx] = entry
  else state.outbox.push(entry)
}

/**
 * Derive and enqueue the change set implied by the current local history.
 * Mutates and returns `state`. Idempotent: calling it again with the same
 * snapshot enqueues nothing new.
 */
export function diffOutbox(
  state: SyncState,
  chats: readonly SnapshotChat[],
  now: number
): SyncState {
  const seen = new Set<string>()

  for (const chat of chats) {
    seen.add(chat.id)
    const sig = sessionSignature(chat)
    const trackedOnServer = !!state.docHlc[docKey("chat_sessions", chat.id)]
    const locallyKnown = chat.id in state.sessionSig
    if (!locallyKnown && trackedOnServer) {
      // Server-originated session (just merged from a pull) — adopt its
      // signature as the baseline silently; do NOT push it back as a local
      // change. A later genuine local edit will differ from this and enqueue.
      state.sessionSig[chat.id] = sig
    } else if (state.sessionSig[chat.id] !== sig) {
      enqueueUpsert(state, "chat_sessions", chat.id, sessionToWireData(chat), now)
      state.sessionSig[chat.id] = sig
    }
    for (const m of chat.messages) {
      if (!m.id) continue
      // A message is immutable once persisted, so only ever enqueue it once:
      // skip if the server already has it or it is already queued.
      if (state.docHlc[docKey("chat_messages", m.id)]) continue
      if (outboxIndex(state, "chat_messages", m.id) >= 0) continue
      // Never ship the empty streaming placeholder of an interrupted turn.
      if (m.role === "assistant" && !m.text) continue
      enqueueUpsert(state, "chat_messages", m.id, messageToWireData(chat.id, m), now)
    }
  }

  // Deletions: a session we have synced or queued that is gone from the
  // snapshot becomes a tombstone (its cascade drops the messages server-side).
  const known = new Set<string>()
  for (const k of Object.keys(state.docHlc)) {
    if (k.startsWith("chat_sessions:")) known.add(k.slice("chat_sessions:".length))
  }
  for (const id of Object.keys(state.sessionSig)) known.add(id)
  for (const e of state.outbox) if (e.collection === "chat_sessions") known.add(e.doc_id)

  for (const id of known) {
    if (seen.has(id)) continue
    handleSessionDelete(state, id, now)
  }
  return state
}

function handleSessionDelete(state: SyncState, sessionId: string, now: number): void {
  // Already tombstoned and pending — don't duplicate.
  const existing = outboxIndex(state, "chat_sessions", sessionId)
  if (existing >= 0 && state.outbox[existing].op === "delete") return

  // Drop any pending upserts for this session and its messages (they'd be
  // orphaned by the cascade). Message entries carry their session in `data`.
  state.outbox = state.outbox.filter((e) => {
    if (e.collection === "chat_sessions" && e.doc_id === sessionId) return false
    if (
      e.collection === "chat_messages" &&
      (e.data as ChatMessageWireData | null)?.session_id === sessionId
    ) {
      return false
    }
    return true
  })
  delete state.sessionSig[sessionId]

  // Only tombstone if the server ever saw this session; otherwise the local
  // create/delete never left this device — nothing to replicate.
  if (state.docHlc[docKey("chat_sessions", sessionId)]) {
    state.outbox.push({
      collection: "chat_sessions",
      doc_id: sessionId,
      op: "delete",
      data: null,
      hlc: issueHlc(state, now),
    })
  }
}

/**
 * Build the push batch from the outbox, stamping each item with its
 * last-seen server HLC as `base_hlc`. Ordered session-upserts → message-
 * upserts → deletes so a new session's row is applied before its messages
 * (the server drops an orphan message whose parent isn't present yet).
 */
export function buildPushItems(state: SyncState): PushItem[] {
  const sessionsUp: PushItem[] = []
  const messagesUp: PushItem[] = []
  const deletes: PushItem[] = []
  for (const e of state.outbox) {
    const base = state.docHlc[docKey(e.collection, e.doc_id)] ?? ""
    const item = toPushItem({ ...e, docId: e.doc_id }, base)
    if (e.op === "delete") deletes.push(item)
    else if (e.collection === "chat_sessions") sessionsUp.push(item)
    else messagesUp.push(item)
  }
  return [...sessionsUp, ...messagesUp, ...deletes]
}

function sessionChangeToPlan(docId: string, data: unknown): MergePlan["sessionUpserts"][number] {
  const d = (data ?? {}) as Record<string, unknown>
  return {
    id: docId,
    title: typeof d.title === "string" && d.title.trim() ? d.title : null,
    updatedAt: toMsField(d.updated_at) || toMsField(d.created_at),
    createdAt: toMsField(d.created_at) || toMsField(d.updated_at),
    trackId: typeof d.track_id === "string" ? d.track_id : null,
  }
}

function changeToMergePlan(change: Change, plan: MergePlan): void {
  if (change.collection === "chat_sessions") {
    if (change.op === "delete") {
      plan.sessionDeletes.push(change.doc_id)
    } else {
      plan.sessionUpserts.push(sessionChangeToPlan(change.doc_id, change.data))
    }
  } else if (change.collection === "chat_messages") {
    if (change.op === "delete") return // messages tombstone only via their session
    const msg = wireDataToMessage(change.doc_id, change.data)
    if (msg) {
      const sid = (change.data as { session_id?: string } | undefined)?.session_id
      if (sid) plan.messageUpserts.push({ sessionId: sid, msg })
    }
  }
}

function toMsField(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v
  if (typeof v === "string") {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** Sessions with a pending delete tombstone in the outbox — a pulled echo of
 *  their (older) create must not resurrect them. */
function pendingDeleteSessions(state: SyncState): Set<string> {
  const s = new Set<string>()
  for (const e of state.outbox) {
    if (e.collection === "chat_sessions" && e.op === "delete") s.add(e.doc_id)
  }
  return s
}

/** Whether the collection's merge rule keeps a pending local write over a
 *  pulled version of the same document. */
function pendingWins(entry: OutboxEntry, change: Change): boolean {
  if (!isSyncedCollection(change.collection)) return false
  const local = pendingToDoc({ ...entry, docId: entry.doc_id })
  return mergeChange(change.collection, local, changeToDoc(change)) === local
}

/**
 * Fold a pulled change page into a merge plan and advance each doc's base
 * HLC. Mutates `state.docHlc`; the caller advances `state.cursor` to
 * `resp.cursor` and applies the returned plan.
 *
 * Two correctness guards, both essential because the server does NOT suppress
 * a device's own echoed writes:
 *  - **collapse in seq order** — a `create … delete` pair for the same doc in
 *    one page nets to whatever the LAST change is (a from-0 re-pull after a
 *    delete must stay deleted, not resurrect on the earlier create);
 *  - **local supersede** — a doc with a pending outbox write whose HLC is ≥ the
 *    pulled change is left to the local version (skip the older echo); a
 *    genuinely newer remote change (from another device) still applies and the
 *    subsequent push conflict resolves it by LWW.
 */
export function reducePull(state: SyncState, resp: PullResponse): MergePlan {
  const sessionOp = new Map<string, { op: "upsert" | "delete"; data?: unknown }>()
  const messages = new Map<string, { sessionId: string; msg: SerializedMsg }>()
  const droppedSessions = new Set<string>()
  const pendingDeletes = pendingDeleteSessions(state)

  for (const change of resp.changes ?? []) {
    const key = docKey(change.collection, change.doc_id)
    if (change.op === "delete") delete state.docHlc[key]
    else state.docHlc[key] = change.hlc

    // Local supersede: a pending local write the merge rule keeps wins over this echo.
    const idx = outboxIndex(state, change.collection, change.doc_id)
    if (idx >= 0 && pendingWins(state.outbox[idx], change)) continue

    if (change.collection === "chat_sessions") {
      if (change.op === "delete") {
        sessionOp.set(change.doc_id, { op: "delete" })
        droppedSessions.add(change.doc_id)
        for (const [mid, mu] of [...messages])
          if (mu.sessionId === change.doc_id) messages.delete(mid)
      } else {
        if (pendingDeletes.has(change.doc_id)) continue // we're deleting it locally
        sessionOp.set(change.doc_id, { op: "upsert", data: change.data })
        droppedSessions.delete(change.doc_id)
      }
    } else if (change.collection === "chat_messages") {
      if (change.op === "delete") continue // messages tombstone only via their session
      const sid = (change.data as { session_id?: string } | undefined)?.session_id
      if (!sid || pendingDeletes.has(sid) || droppedSessions.has(sid)) continue
      const msg = wireDataToMessage(change.doc_id, change.data)
      if (msg) messages.set(change.doc_id, { sessionId: sid, msg })
    }
  }

  const plan = EMPTY_PLAN()
  for (const [id, s] of sessionOp) {
    if (s.op === "delete") plan.sessionDeletes.push(id)
    else plan.sessionUpserts.push(sessionChangeToPlan(id, s.data))
  }
  for (const mu of messages.values()) plan.messageUpserts.push(mu)
  return plan
}

/**
 * Apply a push response: clear applied writes, resolve conflicts by LWW.
 * Returns the master rows the caller must merge locally (conflicts the
 * server won). Mutates `state`.
 */
export function applyPushResponse(state: SyncState, resp: PushResponse): MergePlan {
  const plan = EMPTY_PLAN()

  for (const ref of resp.applied ?? []) {
    const key = docKey(ref.collection, ref.doc_id)
    const idx = outboxIndex(state, ref.collection, ref.doc_id)
    const entry = idx >= 0 ? state.outbox[idx] : undefined
    if (entry) {
      if (entry.op === "delete") {
        delete state.docHlc[key]
        delete state.sessionSig[entry.doc_id]
      } else {
        state.docHlc[key] = entry.hlc
      }
      state.outbox.splice(idx, 1)
    }
  }

  for (const conflict of resp.conflicts ?? []) {
    const key = docKey(conflict.collection, conflict.doc_id)
    const master = conflict.master
    const idx = outboxIndex(state, conflict.collection, conflict.doc_id)
    const entry = idx >= 0 ? state.outbox[idx] : undefined
    // Master HLC is now the base for any re-push regardless of who wins.
    state.docHlc[key] = master.hlc

    // Strictly newer: a master carrying the entry's own HLC is this write,
    // already applied, so the entry is dropped rather than pushed again.
    const localWins = entry ? compareHlcString(entry.hlc, master.hlc) > 0 : false
    if (localWins) {
      // Keep the entry queued; next push carries the fresh base_hlc and
      // fast-forwards over the master.
      continue
    }
    // Master wins — drop our stale write and take the server's version.
    if (entry) state.outbox.splice(idx, 1)
    changeToMergePlan(master, plan)
    if (master.op === "delete" && master.collection === "chat_sessions") {
      delete state.sessionSig[conflict.doc_id]
    }
  }

  return plan
}

/**
 * Seed each just-merged (server-known) session's baseline signature so a later
 * genuine local edit differs from it and enqueues. Skips a session with a
 * pending outbox write — that IS the local edit, and must not be re-baselined
 * away. Call after a pull's merge is applied to the local history.
 */
export function adoptBaseline(state: SyncState, chats: readonly SnapshotChat[]): void {
  for (const chat of chats) {
    if (!state.docHlc[docKey("chat_sessions", chat.id)]) continue
    if (outboxIndex(state, "chat_sessions", chat.id) >= 0) continue
    state.sessionSig[chat.id] = sessionSignature(chat)
  }
}

/** True when there is nothing left to push. */
export function outboxEmpty(state: SyncState): boolean {
  return state.outbox.length === 0
}

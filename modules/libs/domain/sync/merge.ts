/**
 * Per-collection merge rules — the conflict-resolution heart of profile sync.
 *
 * Each rule takes the two competing versions of the SAME document — `local`
 * (what this device holds) and `remote` (the server's current master, returned
 * under `conflicts` on a stale push) — and returns the resolved version to
 * persist and re-push. The rules are:
 *
 * - `listening_sessions` — **grow-only union**. A session is immutable once
 *   closed and only closed sessions sync, so two devices never legitimately
 *   write the same id with different content; a "conflict" is just the same row
 *   arriving twice. Resolution keeps either (deterministically the higher HLC).
 * - `playlist_items` — **add-wins**, keyed by `track_id`. Combine the two
 *   versions field-wise: newest `addedAt`, newest `archivedAt`; the item is in
 *   the library iff `addedAt >= archivedAt`. A stale device can neither
 *   resurrect nor wrongly delete.
 * - `notes` (and chat) — **last-write-wins** by HLC.
 *
 * Every rule is pure, commutative in outcome, and idempotent — merging a value
 * with itself returns an equivalent value — so the engine can re-run them
 * safely and their convergence can be property-tested.
 */

import { compareHlcString } from "./hlc.js"
import type { PlaylistItemSyncData, SyncDoc } from "./types.js"

/** Pick the higher-HLC of two versions of one document (ties impossible: an
 *  HLC is unique per write). Shared by the LWW and grow-only rules. */
function pickByHlc<T>(local: SyncDoc<T>, remote: SyncDoc<T>): SyncDoc<T> {
  return compareHlcString(local.hlc, remote.hlc) >= 0 ? local : remote
}

/**
 * `notes` / chat — **last-write-wins**. The version with the greater HLC wins
 * wholesale (no field-level merge); short single-author text needs nothing
 * finer. A delete tombstone competes on the same footing, so a later delete
 * beats an earlier edit and a later edit beats an earlier delete.
 */
export function mergeNote<T>(local: SyncDoc<T>, remote: SyncDoc<T>): SyncDoc<T> {
  return pickByHlc(local, remote)
}

/**
 * `chat_sessions` — **last-write-wins** by HLC (union on create, LWW on the
 * mutable `title`). Two devices creating a session collide only on an
 * identical uuid, which never happens; the only real conflict is a title
 * rephrase racing across devices, resolved by the higher HLC. A delete
 * tombstone competes on the same footing so a session removed on one device
 * wins over a stale title edit on another (its cascade drops the messages).
 */
export function mergeChatSession<T>(local: SyncDoc<T>, remote: SyncDoc<T>): SyncDoc<T> {
  return pickByHlc(local, remote)
}

/**
 * `chat_messages` — **append-only union, last-write-wins on finalize**. A
 * message is journaled once, when its turn completes (never mid-stream), so
 * two devices never write the same message id with diverging content; the LWW
 * pick is just deterministic convergence when the same completed row arrives
 * twice. Message deletes are not replicated per-row — a session tombstone
 * cascades to its messages — so this rule only ever sees upserts.
 */
export function mergeChatMessage<T>(local: SyncDoc<T>, remote: SyncDoc<T>): SyncDoc<T> {
  return pickByHlc(local, remote)
}

/**
 * `listening_sessions` — **grow-only union** at the document level. Closed
 * sessions are immutable, so both sides should carry identical payloads; we
 * still resolve deterministically by HLC so two devices converge byte-for-byte
 * even if one side re-stamped the row. Never produces a tombstone — sessions
 * are only ever added.
 */
export function mergeListeningSession<T>(local: SyncDoc<T>, remote: SyncDoc<T>): SyncDoc<T> {
  return pickByHlc(local, remote)
}

/**
 * `playlist_items` — **add-wins**, keyed by `track_id`. Adding the same track
 * on two devices collapses to one document; the resolved version takes the
 * newest add and the newest archive independently, then is active iff the add
 * is at least as recent as the archive. The HLC is the greater of the two so
 * the resolved doc keeps advancing the clock.
 */
export function mergePlaylistItem(
  local: SyncDoc<PlaylistItemSyncData>,
  remote: SyncDoc<PlaylistItemSyncData>
): SyncDoc<PlaylistItemSyncData> {
  const winnerHlc = compareHlcString(local.hlc, remote.hlc) >= 0 ? local.hlc : remote.hlc

  const l = local.data
  const r = remote.data
  // A tombstoned playlist doc has no payload; fall back to whichever side
  // still carries data. If BOTH are tombstones there is nothing to add-win,
  // so the delete stands.
  if (l === null && r === null) {
    return { docId: local.docId, hlc: winnerHlc, deleted: true, data: null }
  }
  if (l === null) return { ...remote, hlc: winnerHlc }
  if (r === null) return { ...local, hlc: winnerHlc }

  const addedAt = Math.max(l.addedAt, r.addedAt)
  const archivedAt = maxNullable(l.archivedAt, r.archivedAt)
  // Add-wins: an add at least as recent as the newest archive keeps the item
  // in the library (archive is a soft state carried on the row, not a delete).
  const resolvedArchivedAt = archivedAt !== null && archivedAt > addedAt ? archivedAt : null
  // `collectionId` provenance follows the newest add — prefer the side whose
  // `addedAt` is the winner, keeping a non-null provenance when either has one.
  const provenanceSide = l.addedAt >= r.addedAt ? l : r
  const collectionId = provenanceSide.collectionId ?? l.collectionId ?? r.collectionId ?? null

  return {
    docId: local.docId,
    hlc: winnerHlc,
    deleted: false,
    data: {
      trackId: l.trackId,
      addedAt,
      archivedAt: resolvedArchivedAt,
      collectionId,
    },
  }
}

/** Max of two nullable timestamps, treating `null` as "absent" (never wins). */
function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

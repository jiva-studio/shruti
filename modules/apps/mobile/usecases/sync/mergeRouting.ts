import type { Change } from "@lib/contracts"
import type { OutboxEntry } from "@lib/domain/ports/outboxRepository.js"
import {
  mergeChatMessage,
  mergeChatSession,
  mergeLibraryMembership,
  mergeListeningSession,
  mergeNote,
  mergePlaylistItem,
  type PlaylistItemSyncData,
  type SyncCollection,
  type SyncDoc,
} from "@lib/domain"

/**
 * The wire ⇄ domain mapping and per-collection merge routing for the sync
 * engine. This is the "sync engine maps wire DTOs to/from domain shapes" seam
 * the design doc places in `@usecases`: the domain owns the pure merge rules
 * (`@lib/domain/sync`), the transport owns the opaque wire types
 * (`@lib/contracts`), and this module bridges them.
 *
 * Pure — no IO, no ports. Kept separate so the routing table stays trivially
 * extensible: a new synced collection (e.g. `chat_sessions`, a later lane)
 * slots in by adding one `case` here plus its resolver in the domain.
 */

/** The collections the sync engine journals + merges — the four user-data
 *  collections plus the two chat collections (Lane G). */
const SYNCED_COLLECTIONS: ReadonlySet<string> = new Set<SyncCollection>([
  "notes",
  "playlist_items",
  "listening_sessions",
  "chat_sessions",
  "chat_messages",
  // Personal library (epic #1236): server-owned and pull-only — merged by
  // "apply the server's version" (see mergeChange).
  "library_items",
  // The user's remove/re-add intent for a library item — CLIENT-owned, pushed
  // and merged last-write-wins (see mergeChange).
  "library_memberships",
])

/** Narrow an arbitrary wire `collection` to a collection this engine handles.
 *  A pulled change for any other collection (e.g. a future one) is skipped
 *  rather than mis-merged. */
export function isSyncedCollection(collection: string): collection is SyncCollection {
  return SYNCED_COLLECTIONS.has(collection)
}

/** The collections the device-local "Sync chats" toggle governs. Deliberately
 *  separate from {@link isSyncedCollection}, whose job is "does this engine
 *  know this collection": folding the flag into that type guard would narrow
 *  chat away and silently disarm `mergeChange`'s exhaustive switch. */
const CHAT_COLLECTIONS: ReadonlySet<string> = new Set<SyncCollection>([
  "chat_sessions",
  "chat_messages",
])

/** Whether a change belongs to the chat lane (#1848). */
export function isChatCollection(collection: string): boolean {
  return CHAT_COLLECTIONS.has(collection)
}

/** A wire {@link Change} as the domain merge document (opaque wire `data`). */
export function changeToDoc(change: Change): SyncDoc<unknown> {
  return {
    docId: change.doc_id,
    hlc: change.hlc,
    deleted: change.op === "delete",
    data: change.op === "delete" ? null : (change.data ?? null),
  }
}

/** A pending {@link OutboxEntry} as the domain merge document. */
export function outboxToDoc(entry: OutboxEntry): SyncDoc<unknown> {
  return {
    docId: entry.docId,
    hlc: entry.hlc,
    deleted: entry.op === "delete",
    data: entry.data,
  }
}

/**
 * Resolve two competing versions of one document by its collection's rule.
 * `local` and `remote` carry the client-native (snake_case) wire row in
 * `data`; the result carries the same wire shape, ready to persist / re-push.
 *
 * For `playlist_items` the add-wins rule reasons over a typed payload, so the
 * wire row is projected in and the merged payload projected back out; the LWW
 * / grow-only collections resolve the wire doc wholesale.
 */
export function mergeChange(
  collection: SyncCollection,
  local: SyncDoc<unknown>,
  remote: SyncDoc<unknown>
): SyncDoc<unknown> {
  switch (collection) {
    case "notes":
      return mergeNote(local, remote)
    case "listening_sessions":
      return mergeListeningSession(local, remote)
    case "chat_sessions":
      return mergeChatSession(local, remote)
    case "chat_messages":
      return mergeChatMessage(local, remote)
    case "playlist_items": {
      const merged = mergePlaylistItem(toPlaylistDoc(local), toPlaylistDoc(remote))
      return {
        docId: merged.docId,
        hlc: merged.hlc,
        deleted: merged.deleted,
        data: merged.data === null ? null : playlistPayloadToWire(merged.docId, merged.data),
      }
    }
    case "library_items":
      // Server-owned, pull-only: the server is the single writer, so there is
      // no local version to reconcile — apply its wire row wholesale. `local`
      // is ignored on purpose (the client never journals this collection).
      return remote
    case "library_memberships":
      // Client-owned toggle (archived/active): last-write-wins by HLC on the
      // opaque wire row, no field-level merge.
      return mergeLibraryMembership(local, remote)
  }
}

/* -------------------------------------------------------------------------- */
/*                        playlist_items wire ⇄ payload                        */
/* -------------------------------------------------------------------------- */

interface PlaylistWire {
  readonly track_id: string
  readonly added_at: number
  readonly archived_at: number | null
  readonly collection_id: string | null
}

function toPlaylistDoc(doc: SyncDoc<unknown>): SyncDoc<PlaylistItemSyncData> {
  return {
    docId: doc.docId,
    hlc: doc.hlc,
    deleted: doc.deleted,
    data: doc.data === null ? null : wireToPlaylistPayload(doc.docId, doc.data),
  }
}

function wireToPlaylistPayload(docId: string, data: unknown): PlaylistItemSyncData {
  const w = data as PlaylistWire
  return {
    // The natural sync key is the doc_id (track_id); trust it over the wire
    // row's own track_id so a mismatched snapshot can't split the document.
    trackId: docId,
    addedAt: w.added_at,
    archivedAt: w.archived_at ?? null,
    collectionId: w.collection_id ?? null,
  }
}

function playlistPayloadToWire(docId: string, payload: PlaylistItemSyncData): PlaylistWire {
  return {
    track_id: docId,
    added_at: payload.addedAt,
    archived_at: payload.archivedAt,
    collection_id: payload.collectionId,
  }
}

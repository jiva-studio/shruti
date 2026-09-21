import type { ListeningSessionRow, LibraryMembershipRow } from "@lib/persistence/user"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { ILibraryMembershipRepository } from "@lib/domain/ports/libraryMembershipRepository.js"
import { createJournalWriter } from "./syncJournalWriter.js"
import {
  noteToWire,
  playlistToWire,
  sessionRowToWire,
  libraryMembershipRowToWire,
} from "./syncWire.js"
import { createChatJournaling } from "./syncJournalChat.js"
import type { JournaledUserRepositories, SyncJournalDeps } from "./syncJournalTypes.js"

export type { JournaledUserRepositories, SyncJournalDeps } from "./syncJournalTypes.js"

/**
 * Write-interception (journaling) decorator for the synced user-data
 * repositories.
 *
 * Every upsert/delete on a synced collection is journaled into the `outbox`
 * table **in the same transaction as the domain write**, stamped with a Hybrid
 * Logical Clock. The atomicity comes from a shared reentrant
 * {@link IUnitOfWork}: each mutating call is wrapped in `run`, which either
 * opens a fresh transaction or joins the caller's open one — never a nested
 * BEGIN. Which of the two happens is decided by the transaction HANDLE the
 * caller passes as the trailing `tx` argument; without a live handle the write
 * gets a transaction of its own, so a call from an unrelated stack is never
 * spliced into whatever else is in flight.
 *
 * The journal's `doc_id` is the collection's natural sync key: `track_id` for
 * playlist items, the row id for everything else. `data` is the client-native
 * (snake_case) row snapshot, `null` on a delete tombstone.
 *
 * Scope boundaries:
 * - Only *closed* listening sessions are journaled: `finish` / `finishAt` emit
 *   an upsert, while the mutable in-flight `start` / `forceStart` / `tick` do
 *   not. The snapshot carries the stable `track_id` so a session pulled on
 *   another device re-attaches to the right track.
 * - Chat is gated by the device's "Sync chats" toggle and user-initiated only;
 *   see `syncJournalChat.ts`.
 * - `clearAll` is the local data-wipe path and is not journaled: a wipe is
 *   device-local, not a command to erase the account's data everywhere. The
 *   wipe clears `outbox` and `sync_doc_hlc` itself, so pending upserts for the
 *   wiped rows are dropped rather than pushed.
 * - Every decorated repository is an EXPLICIT member-by-member mapping, never
 *   `{ ...base.x, … }`. A spread satisfies the port structurally, so a
 *   mutating method left un-intercepted would compile silently; with the
 *   literal, a member added to a port is a compile error until it is either
 *   wrapped or listed under a "not journaled, deliberately" comment.
 * - `base_hlc` is left NULL here. Reconciling it against the last-known server
 *   HLC per doc is the sync engine's job before push.
 *
 * Depends only on domain (HLC) and ports — no use case, no sibling infra.
 */
const PLAYLIST_ITEMS = "playlist_items"
const NOTES = "notes"
const LISTENING_SESSIONS = "listening_sessions"
const LIBRARY_MEMBERSHIPS = "library_memberships"

/** Wrap the synced repositories so every mutation is journaled to the outbox
 *  atomically. Read methods are delegated untouched. */
export function withSyncJournaling(
  base: JournaledUserRepositories,
  deps: SyncJournalDeps
): JournaledUserRepositories {
  const { userDb, unitOfWork } = deps
  const isChatSyncEnabled = deps.isChatSyncEnabled ?? (() => true)
  const writer = createJournalWriter(deps)
  const journal = writer.append
  const wasJournaled = writer.wasJournaled

  const notes: INoteRepository = {
    getById: (id) => base.notes.getById(id),
    listByTrack: (trackId) => base.notes.listByTrack(trackId),
    listRecent: (limit) => base.notes.listRecent(limit),
    clearAll: () => base.notes.clearAll(),

    create: (input, tx) =>
      unitOfWork.run(async (scope) => {
        const note = await base.notes.create(input, scope)
        await journal(NOTES, note.id, "upsert", noteToWire(note))
        return note
      }, tx),

    update: (input, tx) =>
      unitOfWork.run(async (scope) => {
        const note = await base.notes.update(input, scope)
        await journal(NOTES, note.id, "upsert", noteToWire(note))
        return note
      }, tx),

    delete: (id, tx) =>
      unitOfWork.run(async (scope) => {
        await base.notes.delete(id, scope)
        await journal(NOTES, id, "delete", null)
      }, tx),
  }

  const playlistItems: IPlaylistItemRepository = {
    getById: (id) => base.playlistItems.getById(id),
    listActive: () => base.playlistItems.listActive(),
    listArchived: () => base.playlistItems.listArchived(),
    clearAll: () => base.playlistItems.clearAll(),

    add: (trackId, collectionId, tx) =>
      unitOfWork.run(async (scope) => {
        const item = await base.playlistItems.add(trackId, collectionId, scope)
        // doc_id is the natural key track_id, not the local pl_… surrogate.
        await journal(PLAYLIST_ITEMS, item.trackId, "upsert", playlistToWire(item))
        return item
      }, tx),

    archive: (id, tx) =>
      unitOfWork.run(async (scope) => {
        await base.playlistItems.archive(id, scope)
        const item = await base.playlistItems.getById(id)
        if (item) await journal(PLAYLIST_ITEMS, item.trackId, "upsert", playlistToWire(item))
      }, tx),

    remove: (id, tx) =>
      unitOfWork.run(async (scope) => {
        // Read the track_id BEFORE the row is gone so the tombstone keys on
        // the natural sync key.
        const item = await base.playlistItems.getById(id)
        await base.playlistItems.remove(id, scope)
        if (item) await journal(PLAYLIST_ITEMS, item.trackId, "delete", null)
      }, tx),
  }

  const listeningSessions: IListeningSessionRepository = {
    // Delegated untouched — reads, plus the in-flight session mutations
    // (start / forceStart / tick) that describe a session still being
    // written, and `clearAll` (local wipe). Only a *closed* session
    // (finish / finishAt) is journaled. Written out member by member on
    // purpose: a spread would satisfy the port structurally and let a
    // newly added mutation slip through un-journaled without a type error.
    start: (args, tx) => base.listeningSessions.start(args, tx),
    forceStart: (args, tx) => base.listeningSessions.forceStart(args, tx),
    forceStartOnce: (args) => base.listeningSessions.forceStartOnce(args),
    tick: (id, args, tx) => base.listeningSessions.tick(id, args, tx),
    getLastSessionForItem: (itemId) => base.listeningSessions.getLastSessionForItem(itemId),
    getResumePositionForItem: (itemId) => base.listeningSessions.getResumePositionForItem(itemId),
    getProgressForItems: (itemIds) => base.listeningSessions.getProgressForItems(itemIds),
    getCompletedAtForItems: (itemIds, durations) =>
      base.listeningSessions.getCompletedAtForItems(itemIds, durations),
    listEverCompletedItems: (itemIds, durations) =>
      base.listeningSessions.listEverCompletedItems(itemIds, durations),
    getDailyTotals: (fromMs, toMs) => base.listeningSessions.getDailyTotals(fromMs, toMs),
    getDailyTotalsByDayOffset: (fromMs, toMs) =>
      base.listeningSessions.getDailyTotalsByDayOffset(fromMs, toMs),
    hasAny: () => base.listeningSessions.hasAny(),
    getTotalListenedSeconds: () => base.listeningSessions.getTotalListenedSeconds(),
    listRecentTracksWithProgress: (limit) =>
      base.listeningSessions.listRecentTracksWithProgress(limit),
    getTracksListenedInRange: (fromMs, toMs) =>
      base.listeningSessions.getTracksListenedInRange(fromMs, toMs),
    clearAll: () => base.listeningSessions.clearAll(),

    finish: (id, args, tx) =>
      unitOfWork.run(async (scope) => {
        await base.listeningSessions.finish(id, args, scope)
        await journalSession(id)
      }, tx),

    finishAt: (id, args, tx) =>
      unitOfWork.run(async (scope) => {
        await base.listeningSessions.finishAt(id, args, scope)
        await journalSession(id)
      }, tx),
  }

  /** Snapshot a closed session row (with its stable `track_id`) and journal it
   *  as an upsert. */
  async function journalSession(id: string): Promise<void> {
    const rows = await userDb.query<ListeningSessionRow>(
      "SELECT * FROM listening_sessions WHERE id = ?",
      [id]
    )
    const row = rows[0]
    if (!row) return
    // Resolve the natural track key from the playlist item so cross-device
    // attribution can re-key on it (the local `item_id` is meaningless off
    // this device).
    const trackRows = await userDb.query<{ track_id: string }>(
      "SELECT track_id FROM playlist_items WHERE id = ? LIMIT 1",
      [row.item_id]
    )
    const trackId = trackRows[0]?.track_id ?? null
    await journal(
      LISTENING_SESSIONS,
      row.id,
      "upsert",
      sessionRowToWire({ ...row, track_id: trackId })
    )
  }

  /* -------------------------- library memberships ------------------------- */

  /** Snapshot the membership row and journal it as an upsert. The client never
   *  deletes a membership (remove/re-add are both upserts), so no tombstone. */
  async function journalMembership(id: string): Promise<void> {
    const rows = await userDb.query<LibraryMembershipRow>(
      "SELECT id, archived_at, updated_at FROM library_memberships WHERE id = ?",
      [id]
    )
    const row = rows[0]
    if (!row) return
    await journal(LIBRARY_MEMBERSHIPS, row.id, "upsert", libraryMembershipRowToWire(row))
  }

  const libraryMemberships: ILibraryMembershipRepository = {
    listArchivedIds: () => base.libraryMemberships.listArchivedIds(),
    getById: (id) => base.libraryMemberships.getById(id),
    clearAll: () => base.libraryMemberships.clearAll(),

    setArchived: (id, tx) =>
      unitOfWork.run(async (scope) => {
        await base.libraryMemberships.setArchived(id, scope)
        await journalMembership(id)
      }, tx),

    setActive: (id, tx) =>
      unitOfWork.run(async (scope) => {
        await base.libraryMemberships.setActive(id, scope)
        await journalMembership(id)
      }, tx),
  }

  const chat = createChatJournaling({
    base,
    userDb,
    unitOfWork,
    journal,
    wasJournaled,
    isChatSyncEnabled,
  })

  return {
    notes,
    playlistItems,
    listeningSessions,
    chatSessions: chat.chatSessions,
    chatMessages: chat.chatMessages,
    libraryMemberships,
  }
}

import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { ILibraryMembershipRepository } from "@lib/domain/ports/libraryMembershipRepository.js"
import type { ListeningSessionRow, LibraryMembershipRow } from "@lib/persistence/user"
import { hlcNow, hlcToString, parseHlc, type SyncOp } from "@lib/domain"
import {
  noteToWire,
  playlistToWire,
  sessionRowToWire,
  chatSessionRowToWire,
  chatMessageRowToWire,
  libraryMembershipRowToWire,
  type ChatSessionWire,
  type ChatMessageWire,
} from "./syncWire.js"

/**
 * Write-interception (journaling) decorator for the synced user-data
 * repositories — `notes`, `playlist_items`, `listening_sessions`, and the two
 * chat collections `chat_sessions` / `chat_messages` (Lane G).
 *
 * Every upsert/delete on a synced collection is journaled into the `outbox`
 * table **in the same transaction as the domain write**, stamped with a
 * Hybrid Logical Clock. The atomicity comes from a shared reentrant
 * {@link IUnitOfWork}: the decorator wraps each mutating call in `run`, which
 * either opens a fresh transaction (standalone write) or joins the caller's
 * open one — never a nested BEGIN. Which of the two happens is decided by the
 * transaction HANDLE the caller passes as the mutating method's trailing `tx`
 * argument (`addTrackToPlaylist`, `deleteNote`, `useChatStore.deleteSession`, …
 * do); without a live handle the write gets a transaction of its own, so a
 * call from an unrelated stack is never spliced into whatever else happens to
 * be in flight (#1493).
 *
 * The journal's `doc_id` is the collection's natural sync key: `track_id` for
 * playlist items (not the local `pl_…` surrogate), and the row id for notes /
 * sessions / chat rows. `data` is the client-native (snake_case) row snapshot;
 * `null` on a delete tombstone.
 *
 * Scope boundaries:
 * - Only *closed* listening sessions are journaled: `finish` / `finishAt` emit
 *   an upsert; `start` / `forceStart` / `tick` (mutable, in-flight) do not. The
 *   snapshot carries the stable `track_id` (resolved via the playlist item) so
 *   a session pulled on another device re-attaches to the right track.
 * - **Chat is gated + user-initiated only.** Chat journaling is skipped
 *   entirely when the device's "Sync chats" toggle is off
 *   (`isChatSyncEnabled()`). Proactive/scheduler messages are written straight
 *   to SQL by the proactive repository (never through `chatMessages.create`),
 *   so they never reach this decorator; the `chat_messages_proactive_state`
 *   sidecar is never a synced collection. Only *completed* messages are
 *   journaled — `create` is called once the turn's content is final (never per
 *   streaming token). A message's parent session is journaled **before** the
 *   message (parent-before-child), and only sessions that carry a
 *   user-initiated message are ever journaled — a proactive-only session
 *   stays out of sync.
 * - `clearAll` is the local data-wipe path (delete account / reset) — it is not
 *   journaled, because a wipe is meant to be device-local, not a command to
 *   erase the account's data everywhere. That holds because `wipeLocalUserData`
 *   clears `outbox` and `sync_doc_hlc` itself (#1496): the pending upserts for
 *   the wiped rows are dropped rather than pushed, which is what keeps a
 *   same-identity wipe from re-creating the data server-side. Clearing the sync
 *   tables lives there, not in the decorator.
 * - Every decorated repository is built as an EXPLICIT member-by-member
 *   mapping, never `{ ...base.x, … }`. A spread satisfies the port
 *   structurally, so a mutating method left un-intercepted compiles silently
 *   (that is how `delete` / `deleteBySession` / `updateActionStates` /
 *   `updateFollowups` shipped un-journaled). With the literal, a member added
 *   to a port is a compile error until it is either wrapped or listed under
 *   the "not journaled, deliberately" comment above the delegating entries.
 * - `base_hlc` is left NULL here. Reconciling it against the last-known server
 *   HLC per doc is the sync engine's job (Lane D) before push.
 *
 * Depends only on domain (HLC) + ports — no use-case, no sibling infra.
 */
export interface SyncJournalDeps {
  /** The user database — same connection the wrapped repositories write to. */
  readonly userDb: IDatabase
  /** Reentrant unit-of-work SHARED with the repository bundle's `unitOfWork`,
   *  so a journal joins the caller's transaction — when the caller hands its
   *  handle down — instead of dead-locking on a nested BEGIN. */
  readonly unitOfWork: IUnitOfWork
  /** Resolves this device's stable id (the HLC tiebreak). Supplied by the
   *  composition root from the auth/device layer; kept as a provider because
   *  the underlying `Device.getId()` is async. */
  readonly getDeviceId: () => Promise<string>
  /** Resolves the account journaling right now — stamped on each row (023
   *  migration) so push can tell a deleted account's un-pushed changes from
   *  the ones the identity replacing it wrote. Read per write, never captured:
   *  the identity changes under a live bundle. Omitted ⇒ rows are unowned. */
  readonly getOwnerId?: () => string | null
  /** Device-local "Sync chats" gate (default ON). Read on every chat write;
   *  when it returns `false` no chat change is journaled. Omitted ⇒ treated as
   *  ON. Never gates the non-chat collections. */
  readonly isChatSyncEnabled?: () => boolean
}

/** The repositories the decorator wraps. */
export interface JournaledUserRepositories {
  readonly notes: INoteRepository
  readonly playlistItems: IPlaylistItemRepository
  readonly listeningSessions: IListeningSessionRepository
  readonly chatSessions: IChatSessionRepository
  readonly chatMessages: IChatMessageRepository
  readonly libraryMemberships: ILibraryMembershipRepository
}

const PLAYLIST_ITEMS = "playlist_items"
const NOTES = "notes"
const LISTENING_SESSIONS = "listening_sessions"
const CHAT_SESSIONS = "chat_sessions"
const CHAT_MESSAGES = "chat_messages"
const LIBRARY_MEMBERSHIPS = "library_memberships"

/** Wrap the synced repositories so every mutation is journaled to the outbox
 *  atomically. Read methods are delegated untouched. */
export function withSyncJournaling(
  base: JournaledUserRepositories,
  deps: SyncJournalDeps
): JournaledUserRepositories {
  const { userDb, unitOfWork, getDeviceId } = deps
  const isChatSyncEnabled = deps.isChatSyncEnabled ?? (() => true)

  /** Append one outbox row, computing the next HLC from the highest stamp this
   *  device has issued or observed so stamps stay monotonic against BOTH.
   *  Runs inside the caller's transaction. */
  async function journal(
    collection: string,
    docId: string,
    op: SyncOp,
    data: unknown | null
  ): Promise<void> {
    const deviceId = await getDeviceId()
    // The outbox tail alone is only what this device has ISSUED. A remote
    // stamp already pulled in (`sync_doc_hlc`) is just as much part of the
    // clock: skip it and a device whose wall clock trails another's stamps its
    // edit BELOW the change that edit descends from — the server accepts the
    // push (it gates on `base_hlc`, not on ordering), and every device that
    // pulls both then resolves LWW in favour of the older text (#1628).
    //
    // Plain MAX over the union: `hlcToString` zero-pads both numeric
    // components, so SQLite's lexicographic order is the order `compareHlc`
    // defines.
    const rows = await userDb.query<{ hlc: string | null }>(
      `SELECT MAX(hlc) AS hlc FROM (
         SELECT (SELECT hlc FROM outbox ORDER BY id DESC LIMIT 1) AS hlc
         UNION ALL
         SELECT (SELECT MAX(server_hlc) FROM sync_doc_hlc)
       )`
    )
    const seed = rows[0]?.hlc ?? null
    const lastSeen = seed === null ? null : parseHlc(seed)
    const hlc = hlcToString(hlcNow(deviceId, lastSeen))
    await userDb.execute(
      `INSERT INTO outbox
         (collection, doc_id, op, data, hlc, base_hlc, created_at, sent, owner_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?)`,
      [
        collection,
        docId,
        op,
        data === null ? null : JSON.stringify(data),
        hlc,
        Date.now(),
        deps.getOwnerId?.() ?? null,
      ]
    )
  }

  /** True if `(collection, doc_id)` already has a pending outbox row or a
   *  recorded server HLC — i.e. the document has entered sync at least once. */
  async function wasJournaled(collection: string, docId: string): Promise<boolean> {
    const ob = await userDb.query<{ one: number }>(
      "SELECT 1 AS one FROM outbox WHERE collection = ? AND doc_id = ? LIMIT 1",
      [collection, docId]
    )
    if (ob.length > 0) return true
    const sh = await userDb.query<{ one: number }>(
      "SELECT 1 AS one FROM sync_doc_hlc WHERE collection = ? AND doc_id = ? LIMIT 1",
      [collection, docId]
    )
    return sh.length > 0
  }

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

  /* ----------------------------- chat sessions ---------------------------- */

  /** Snapshot a chat session row and journal it as an upsert. */
  async function journalChatSession(id: string): Promise<void> {
    const rows = await userDb.query<ChatSessionWire>(
      "SELECT id, title, created_at, updated_at, track_id FROM chat_sessions WHERE id = ?",
      [id]
    )
    const row = rows[0]
    if (!row) return
    await journal(CHAT_SESSIONS, row.id, "upsert", chatSessionRowToWire(row))
  }

  /** Journal the parent session once, before any of its messages, so a pulled
   *  batch (single global cursor → total order) applies the session ahead of
   *  its children. A proactive-only session is never journaled — its messages
   *  bypass `chatMessages.create`, so this is never reached for one. */
  async function ensureSessionJournaled(sessionId: string): Promise<void> {
    if (await wasJournaled(CHAT_SESSIONS, sessionId)) return
    await journalChatSession(sessionId)
  }

  const chatSessions: IChatSessionRepository = {
    list: (limit) => base.chatSessions.list(limit),
    getById: (id) => base.chatSessions.getById(id),
    findLatestByTrack: (trackId) => base.chatSessions.findLatestByTrack(trackId),

    // Not journaled, deliberately:
    // - `create` — a session enters sync lazily, with its first
    //   user-initiated message (see `ensureSessionJournaled`); a
    //   proactive-only session must never be pushed.
    // - `touch` — bumps `updated_at` for local list ordering only.
    // - `clearAll` — the local data-wipe path, deliberately device-local; the
    //   wipe drops the outbox rows itself, so nothing is pushed (file header).
    create: (input) => base.chatSessions.create(input),
    touch: (id, updatedAtMs) => base.chatSessions.touch(id, updatedAtMs),
    clearAll: () => base.chatSessions.clearAll(),

    updateTitle: (id, title, tx) =>
      unitOfWork.run(async (scope) => {
        await base.chatSessions.updateTitle(id, title, scope)
        // Only re-journal the title (LWW) for a session already in sync — a
        // proactive session (never journaled) has nothing to update remotely.
        if (isChatSyncEnabled() && (await wasJournaled(CHAT_SESSIONS, id))) {
          await journalChatSession(id)
        }
      }, tx),

    delete: (id, tx) =>
      unitOfWork.run(async (scope) => {
        // Decide before the row is gone: only a session that entered sync gets
        // a tombstone (its cascade drops the messages on every device).
        const tombstone = isChatSyncEnabled() && (await wasJournaled(CHAT_SESSIONS, id))
        await base.chatSessions.delete(id, scope)
        if (tombstone) await journal(CHAT_SESSIONS, id, "delete", null)
      }, tx),
  }

  /* ----------------------------- chat messages ---------------------------- */

  /** Snapshot a completed message row (exact persisted `meta` envelope) and
   *  journal it as an upsert. */
  async function journalChatMessage(id: string): Promise<void> {
    const rows = await userDb.query<ChatMessageWire>(
      "SELECT id, session_id, role, content, created_at, meta FROM chat_messages WHERE id = ?",
      [id]
    )
    const row = rows[0]
    if (!row) return
    await journal(CHAT_MESSAGES, row.id, "upsert", chatMessageRowToWire(row))
  }

  /** Re-journal a message whose `meta` was rewritten in place. Only a message
   *  already in sync is re-snapshotted — a proactive / never-pushed message has
   *  nothing to update remotely. Runs in its own journal transaction: the base
   *  `update*` methods open a transaction of their own, and SQLite has no
   *  nested ones, so the write cannot be joined here. */
  async function rejournalChatMessage(id: string): Promise<void> {
    if (!isChatSyncEnabled()) return
    await unitOfWork.run(async () => {
      if (await wasJournaled(CHAT_MESSAGES, id)) await journalChatMessage(id)
    })
  }

  /** True while the parent session row is still there. `deleteBySession` reads
   *  it to tell "clear this conversation's messages" (parent kept — the
   *  messages need their own tombstones) from the whole-conversation delete
   *  (parent already removed in this transaction — its tombstone cascades). */
  async function sessionRowExists(sessionId: string): Promise<boolean> {
    const rows = await userDb.query<{ one: number }>(
      "SELECT 1 AS one FROM chat_sessions WHERE id = ? LIMIT 1",
      [sessionId]
    )
    return rows.length > 0
  }

  /** Ids of a session's messages that have entered sync — read BEFORE the rows
   *  are gone so `deleteBySession` can tombstone each of them.
   *
   *  One statement, and deliberately CORRELATED. Both arms are covering-index
   *  seeks per message — `idx_outbox_collection_doc (collection, doc_id)` and
   *  `sync_doc_hlc`'s `PRIMARY KEY (collection, doc_id)` — so the cost is
   *  O(messages in the session), flat in the size of the journal. The
   *  uncorrelated `id IN (… UNION …)` form reads better but materialises every
   *  journaled chat doc_id into a temp b-tree first, making the delete O(whole
   *  outbox) on a table that is append-only and never compacted. */
  async function journaledMessageIds(sessionId: string): Promise<string[]> {
    const rows = await userDb.query<{ id: string }>(
      `SELECT m.id FROM chat_messages m
        WHERE m.session_id = ?
          AND (EXISTS (SELECT 1 FROM outbox o
                        WHERE o.collection = ? AND o.doc_id = m.id)
            OR EXISTS (SELECT 1 FROM sync_doc_hlc s
                        WHERE s.collection = ? AND s.doc_id = m.id))`,
      [sessionId, CHAT_MESSAGES, CHAT_MESSAGES]
    )
    return rows.map((row) => row.id)
  }

  const chatMessages: IChatMessageRepository = {
    listBySession: (sessionId) => base.chatMessages.listBySession(sessionId),

    // Not journaled, deliberately:
    // - `updateFeedback` — device-local UI state for the 👍/👎 control; the
    //   feedback itself travels over `/chat/feedback`, not through sync.
    // - `clearAll` — the local data-wipe path (delete account / reset), which
    //   is device-local by design: it must not tombstone the account's chat on
    //   every other device. The wipe clears the outbox and `sync_doc_hlc` in
    //   the same pass, so nothing stale is left to push (see the file header).
    updateFeedback: (id, feedback) => base.chatMessages.updateFeedback(id, feedback),
    clearAll: () => base.chatMessages.clearAll(),

    create: (input, tx) =>
      unitOfWork.run(async (scope) => {
        const msg = await base.chatMessages.create(input, scope)
        // Completed messages only: `create` is the finalise seam (streaming
        // tokens never touch it). Journal the parent session first.
        if (isChatSyncEnabled()) {
          await ensureSessionJournaled(input.sessionId)
          await journalChatMessage(msg.id)
        }
        return msg
      }, tx),

    // `meta` is part of the journaled snapshot, so an in-place rewrite of it
    // has to be re-journaled (LWW) or the server copy silently diverges.
    updateActionStates: async (id, actionStates) => {
      await base.chatMessages.updateActionStates(id, actionStates)
      await rejournalChatMessage(id)
    },

    updateFollowups: async (id, followups) => {
      await base.chatMessages.updateFollowups(id, followups)
      await rejournalChatMessage(id)
    },

    delete: (id, tx) =>
      unitOfWork.run(async (scope) => {
        // Decide before the row is gone — same rule as the session tombstone:
        // only a message that entered sync gets one. Chat retry deletes the
        // failed assistant reply AND its user prompt; without the tombstone
        // the server and every other device would keep them forever.
        const tombstone = isChatSyncEnabled() && (await wasJournaled(CHAT_MESSAGES, id))
        await base.chatMessages.delete(id, scope)
        if (tombstone) await journal(CHAT_MESSAGES, id, "delete", null)
      }, tx),

    deleteBySession: (sessionId, tx) =>
      unitOfWork.run(async (scope) => {
        // Tombstone each synced message ONLY when the parent session survives.
        //
        // Whole-conversation delete (`useChatStore.deleteSession`) removes the
        // session first, in this same transaction: its tombstone already
        // cascades to the messages server-side, so N per-message tombstones
        // would be pure duplication written forever into a journal that is
        // never compacted. A gone parent is also the only case where skipping
        // is safe — a session that was never journaled has no journaled
        // messages either (`create` journals the parent first), so nothing is
        // left stranded on the server.
        //
        // Called on its own (the parent kept), this is the only signal the
        // messages are gone, so every synced one gets its tombstone.
        const orphaned = isChatSyncEnabled() && (await sessionRowExists(sessionId))
        const ids = orphaned ? await journaledMessageIds(sessionId) : []
        await base.chatMessages.deleteBySession(sessionId, scope)
        for (const id of ids) await journal(CHAT_MESSAGES, id, "delete", null)
      }, tx),
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

  return {
    notes,
    playlistItems,
    listeningSessions,
    chatSessions,
    chatMessages,
    libraryMemberships,
  }
}

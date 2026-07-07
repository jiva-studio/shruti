import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { Note } from "@lib/domain/note.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { ListeningSessionRow } from "@lib/persistence/user"
import { hlcNow, hlcToString, parseHlc, type SyncOp } from "@lib/domain"
import {
  sessionRowToWire,
  chatSessionRowToWire,
  chatMessageRowToWire,
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
 * open one (e.g. `addTrackToPlaylist`, `deleteNote`) — never a nested BEGIN.
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
 *   journaled; the wipe clears the outbox itself.
 * - `base_hlc` is left NULL here. Reconciling it against the last-known server
 *   HLC per doc is the sync engine's job (Lane D) before push.
 *
 * Depends only on domain (HLC) + ports — no use-case, no sibling infra.
 */
export interface SyncJournalDeps {
  /** The user database — same connection the wrapped repositories write to. */
  readonly userDb: IDatabase
  /** Reentrant unit-of-work SHARED with the repository bundle's `unitOfWork`,
   *  so a journal joins an outer caller transaction instead of dead-locking. */
  readonly unitOfWork: IUnitOfWork
  /** Resolves this device's stable id (the HLC tiebreak). Supplied by the
   *  composition root from the auth/device layer; kept as a provider because
   *  the underlying `Device.getId()` is async. */
  readonly getDeviceId: () => Promise<string>
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
}

const PLAYLIST_ITEMS = "playlist_items"
const NOTES = "notes"
const LISTENING_SESSIONS = "listening_sessions"
const CHAT_SESSIONS = "chat_sessions"
const CHAT_MESSAGES = "chat_messages"

/** Wrap the synced repositories so every mutation is journaled to the outbox
 *  atomically. Read methods are delegated untouched. */
export function withSyncJournaling(
  base: JournaledUserRepositories,
  deps: SyncJournalDeps
): JournaledUserRepositories {
  const { userDb, unitOfWork, getDeviceId } = deps
  const isChatSyncEnabled = deps.isChatSyncEnabled ?? (() => true)

  /** Append one outbox row, computing the next HLC from the last journaled
   *  one so stamps stay monotonic. Runs inside the caller's transaction. */
  async function journal(
    collection: string,
    docId: string,
    op: SyncOp,
    data: unknown | null
  ): Promise<void> {
    const deviceId = await getDeviceId()
    const rows = await userDb.query<{ hlc: string }>(
      "SELECT hlc FROM outbox ORDER BY id DESC LIMIT 1"
    )
    const lastSeen = rows.length > 0 ? parseHlc(rows[0]!.hlc) : null
    const hlc = hlcToString(hlcNow(deviceId, lastSeen))
    await userDb.execute(
      `INSERT INTO outbox (collection, doc_id, op, data, hlc, base_hlc, created_at, sent)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 0)`,
      [collection, docId, op, data === null ? null : JSON.stringify(data), hlc, Date.now()]
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

    create: (input) =>
      unitOfWork.run(async () => {
        const note = await base.notes.create(input)
        await journal(NOTES, note.id, "upsert", noteWire(note))
        return note
      }),

    update: (input) =>
      unitOfWork.run(async () => {
        const note = await base.notes.update(input)
        await journal(NOTES, note.id, "upsert", noteWire(note))
        return note
      }),

    delete: (id) =>
      unitOfWork.run(async () => {
        await base.notes.delete(id)
        await journal(NOTES, id, "delete", null)
      }),
  }

  const playlistItems: IPlaylistItemRepository = {
    getById: (id) => base.playlistItems.getById(id),
    listActive: () => base.playlistItems.listActive(),
    listArchived: () => base.playlistItems.listArchived(),
    clearAll: () => base.playlistItems.clearAll(),

    add: (trackId, collectionId) =>
      unitOfWork.run(async () => {
        const item = await base.playlistItems.add(trackId, collectionId)
        // doc_id is the natural key track_id, not the local pl_… surrogate.
        await journal(PLAYLIST_ITEMS, item.trackId, "upsert", playlistWire(item))
        return item
      }),

    archive: (id) =>
      unitOfWork.run(async () => {
        await base.playlistItems.archive(id)
        const item = await base.playlistItems.getById(id)
        if (item) await journal(PLAYLIST_ITEMS, item.trackId, "upsert", playlistWire(item))
      }),

    remove: (id) =>
      unitOfWork.run(async () => {
        // Read the track_id BEFORE the row is gone so the tombstone keys on
        // the natural sync key.
        const item = await base.playlistItems.getById(id)
        await base.playlistItems.remove(id)
        if (item) await journal(PLAYLIST_ITEMS, item.trackId, "delete", null)
      }),
  }

  const listeningSessions: IListeningSessionRepository = {
    // Reads + in-flight session mutations are delegated untouched; only a
    // *closed* session (finish / finishAt) is journaled.
    ...base.listeningSessions,

    finish: (id, args) =>
      unitOfWork.run(async () => {
        await base.listeningSessions.finish(id, args)
        await journalSession(id)
      }),

    finishAt: (id, args) =>
      unitOfWork.run(async () => {
        await base.listeningSessions.finishAt(id, args)
        await journalSession(id)
      }),
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
    ...base.chatSessions,

    updateTitle: (id, title) =>
      unitOfWork.run(async () => {
        await base.chatSessions.updateTitle(id, title)
        // Only re-journal the title (LWW) for a session already in sync — a
        // proactive session (never journaled) has nothing to update remotely.
        if (isChatSyncEnabled() && (await wasJournaled(CHAT_SESSIONS, id))) {
          await journalChatSession(id)
        }
      }),

    delete: (id) =>
      unitOfWork.run(async () => {
        // Decide before the row is gone: only a session that entered sync gets
        // a tombstone (its cascade drops the messages on every device).
        const tombstone = isChatSyncEnabled() && (await wasJournaled(CHAT_SESSIONS, id))
        await base.chatSessions.delete(id)
        if (tombstone) await journal(CHAT_SESSIONS, id, "delete", null)
      }),
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

  const chatMessages: IChatMessageRepository = {
    ...base.chatMessages,

    create: (input) =>
      unitOfWork.run(async () => {
        const msg = await base.chatMessages.create(input)
        // Completed messages only: `create` is the finalise seam (streaming
        // tokens never touch it). Journal the parent session first.
        if (isChatSyncEnabled()) {
          await ensureSessionJournaled(input.sessionId)
          await journalChatMessage(msg.id)
        }
        return msg
      }),
  }

  return { notes, playlistItems, listeningSessions, chatSessions, chatMessages }
}

/* --- client-native (snake_case) row snapshots for outbox.data --- */

function noteWire(note: Note) {
  return {
    id: note.id,
    track_id: note.trackId,
    text: note.text,
    time_start: note.timeStart,
    time_end: note.timeEnd,
    created_at: note.createdAt,
    meta: note.meta,
  }
}

function playlistWire(item: PlaylistItem) {
  return {
    id: item.id,
    track_id: item.trackId,
    added_at: item.addedAt,
    archived_at: item.archivedAt,
    collection_id: item.collectionId,
  }
}

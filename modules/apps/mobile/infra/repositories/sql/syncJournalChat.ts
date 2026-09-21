import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { SyncOp } from "@lib/domain"
import {
  chatMessageRowToWire,
  chatSessionRowToWire,
  type ChatMessageWire,
  type ChatSessionWire,
} from "./syncWire.js"
import type { JournaledUserRepositories } from "./syncJournalTypes.js"

const CHAT_SESSIONS = "chat_sessions"
const CHAT_MESSAGES = "chat_messages"

export interface ChatJournalingDeps {
  readonly base: JournaledUserRepositories
  readonly userDb: IDatabase
  readonly unitOfWork: IUnitOfWork
  readonly journal: (
    collection: string,
    docId: string,
    op: SyncOp,
    data: unknown | null
  ) => Promise<void>
  readonly wasJournaled: (collection: string, docId: string) => Promise<boolean>
  /** Device-local "Sync chats" gate, read on every chat write. */
  readonly isChatSyncEnabled: () => boolean
}

export interface ChatJournaling {
  readonly chatSessions: IChatSessionRepository
  readonly chatMessages: IChatMessageRepository
}

/**
 * Journaling wrappers for the two chat collections. Gated and user-initiated
 * only: proactive messages are written straight to SQL by the proactive
 * repository and never reach these, and a session is journaled before any of
 * its messages so a pulled batch applies the parent first.
 */
export function createChatJournaling(deps: ChatJournalingDeps): ChatJournaling {
  const { base, userDb, unitOfWork, journal, wasJournaled, isChatSyncEnabled } = deps

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
    // - `touch` — every completed turn calls it, so journaling it would add an
    //   outbox row (an append-only table: one full session snapshot pushed per
    //   row) per turn per session, for a column no reader needs on the wire.
    //   The history list no longer sorts on it: `chatSessions.list` derives
    //   its order from the newest visible message's `created_at`, which is
    //   already synced as part of the message. Nothing about `updated_at` is
    //   therefore device-visible off this device — which is what "local list
    //   ordering only" was asserting, wrongly, while the list did sort on it.
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

  return { chatSessions, chatMessages }
}

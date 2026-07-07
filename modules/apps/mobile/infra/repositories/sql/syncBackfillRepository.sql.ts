import type { IDatabase } from "@ports/app/index.js"
import type {
  BackfillCandidate,
  ISyncBackfillRepository,
} from "@lib/domain/ports/syncBackfillRepository.js"
import type { NoteRow, PlaylistItemRow, ListeningSessionRow } from "@lib/persistence/user"
import {
  noteRowToWire,
  playlistRowToWire,
  sessionRowToWire,
  chatSessionRowToWire,
  chatMessageRowToWire,
  type ChatSessionWire,
  type ChatMessageWire,
} from "./syncWire.js"

/**
 * SQL adapter over the three synced collection tables implementing
 * {@link ISyncBackfillRepository} — the read side of the first-sync backfill
 * (Lane E2b).
 *
 * `listUnsynced` returns every `notes` / `playlist_items` / `listening_sessions`
 * row — and, when chat sync is on, every user-initiated `chat_sessions` /
 * `chat_messages` row — that has **no** matching `outbox` entry and **no**
 * `sync_doc_hlc` record: the rows created before journaling was on (while the
 * device was anonymous). Each is shaped into the client-native (snake_case)
 * wire snapshot through the **shared** builders in `syncWire.ts` — the same
 * serializers the apply path uses and byte-identical to what the journal
 * decorator emits — so a backfilled `outbox.data` matches a journaled row
 * exactly. The session builder resolves the natural `track_id` via a
 * `playlist_items` LEFT JOIN (the local session row stores only `item_id`).
 *
 * Chat backfill mirrors the decorator's gates exactly, or a re-signed-in device
 * would sync a different chat history than a freshly-journaled one:
 *   - `isChatSyncEnabled()` gates the whole chat scan (default ON, like the
 *     decorator) — a device with the toggle off backfills no chat;
 *   - **proactive** messages are excluded (they bypass `chatMessages.create`,
 *     so they never journal) — a message is user-initiated iff it has no
 *     `chat_messages_proactive_state` row;
 *   - a session is a candidate only if it carries ≥1 user-initiated message (a
 *     proactive-only session stays out of sync), and every session is emitted
 *     **before** any message (parent-before-child), so the apply side never
 *     orphan-drops a backfilled message.
 *
 * The `NOT EXISTS` anti-join is the idempotency guard: once a row is enqueued
 * it owns an outbox entry and drops out of the candidate set, so a second pass
 * returns nothing. Reads only; the enclosing reentrant unit-of-work (opened by
 * the use case) owns the transaction.
 */
export function createSqlSyncBackfillRepository(
  db: IDatabase,
  isChatSyncEnabled: () => boolean = () => true
): ISyncBackfillRepository {
  return {
    async listUnsynced(): Promise<readonly BackfillCandidate[]> {
      const out: BackfillCandidate[] = []

      // notes — doc_id is the row id.
      const noteRows = await db.query<NoteRow>(
        `SELECT n.* FROM notes n
          WHERE NOT EXISTS (
                  SELECT 1 FROM outbox o
                   WHERE o.collection = 'notes' AND o.doc_id = n.id)
            AND NOT EXISTS (
                  SELECT 1 FROM sync_doc_hlc s
                   WHERE s.collection = 'notes' AND s.doc_id = n.id)`
      )
      for (const row of noteRows) {
        out.push({ collection: "notes", docId: row.id, data: noteRowToWire(row) })
      }

      // playlist_items — doc_id is the natural key track_id, NOT the local
      // pl_… surrogate. A track present under several surrogate rows collapses
      // to one document (latest added_at wins), mirroring the merge key.
      const playlistRows = await db.query<PlaylistItemRow>(
        `SELECT p.* FROM playlist_items p
          WHERE NOT EXISTS (
                  SELECT 1 FROM outbox o
                   WHERE o.collection = 'playlist_items' AND o.doc_id = p.track_id)
            AND NOT EXISTS (
                  SELECT 1 FROM sync_doc_hlc s
                   WHERE s.collection = 'playlist_items' AND s.doc_id = p.track_id)`
      )
      const latestByTrack = new Map<string, PlaylistItemRow>()
      for (const row of playlistRows) {
        const prev = latestByTrack.get(row.track_id)
        if (!prev || row.added_at > prev.added_at) latestByTrack.set(row.track_id, row)
      }
      for (const row of latestByTrack.values()) {
        out.push({
          collection: "playlist_items",
          docId: row.track_id,
          data: playlistRowToWire(row),
        })
      }

      // listening_sessions — doc_id is the row id (grow-only union). The local
      // table stores only `item_id`; resolve the natural `track_id` via the
      // same `playlist_items` LEFT JOIN the live journal / apply paths use, so a
      // backfilled session carries its track attribution byte-identically. (It
      // used to ship the raw row without `track_id`, silently losing it.)
      const sessionRows = await db.query<ListeningSessionRow & { track_id: string | null }>(
        `SELECT l.*, pi.track_id AS track_id
           FROM listening_sessions l
           LEFT JOIN playlist_items pi ON pi.id = l.item_id
          WHERE NOT EXISTS (
                  SELECT 1 FROM outbox o
                   WHERE o.collection = 'listening_sessions' AND o.doc_id = l.id)
            AND NOT EXISTS (
                  SELECT 1 FROM sync_doc_hlc s
                   WHERE s.collection = 'listening_sessions' AND s.doc_id = l.id)`
      )
      for (const row of sessionRows) {
        out.push({ collection: "listening_sessions", docId: row.id, data: sessionRowToWire(row) })
      }

      // chat — gated by the device's "Sync chats" toggle, exactly like the
      // journal decorator. Sessions FIRST (parent-before-child), then their
      // user-initiated messages, both filtered to rows without an outbox /
      // sync_doc_hlc record.
      if (isChatSyncEnabled()) {
        // Sessions that carry ≥1 user-initiated (non-proactive) message — a
        // proactive-only session never journals, so it must not backfill.
        const chatSessionRows = await db.query<ChatSessionWire>(
          `SELECT c.id, c.title, c.created_at, c.updated_at, c.track_id
             FROM chat_sessions c
            WHERE EXISTS (
                    SELECT 1 FROM chat_messages m
                     WHERE m.session_id = c.id
                       AND NOT EXISTS (
                             SELECT 1 FROM chat_messages_proactive_state p
                              WHERE p.chat_message_id = m.id))
              AND NOT EXISTS (
                    SELECT 1 FROM outbox o
                     WHERE o.collection = 'chat_sessions' AND o.doc_id = c.id)
              AND NOT EXISTS (
                    SELECT 1 FROM sync_doc_hlc s
                     WHERE s.collection = 'chat_sessions' AND s.doc_id = c.id)`
        )
        for (const row of chatSessionRows) {
          out.push({ collection: "chat_sessions", docId: row.id, data: chatSessionRowToWire(row) })
        }

        // User-initiated messages only (proactive ones bypass journaling).
        const chatMessageRows = await db.query<ChatMessageWire>(
          `SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.meta
             FROM chat_messages m
            WHERE NOT EXISTS (
                    SELECT 1 FROM chat_messages_proactive_state p
                     WHERE p.chat_message_id = m.id)
              AND NOT EXISTS (
                    SELECT 1 FROM outbox o
                     WHERE o.collection = 'chat_messages' AND o.doc_id = m.id)
              AND NOT EXISTS (
                    SELECT 1 FROM sync_doc_hlc s
                     WHERE s.collection = 'chat_messages' AND s.doc_id = m.id)`
        )
        for (const row of chatMessageRows) {
          out.push({ collection: "chat_messages", docId: row.id, data: chatMessageRowToWire(row) })
        }
      }

      return out
    },
  }
}

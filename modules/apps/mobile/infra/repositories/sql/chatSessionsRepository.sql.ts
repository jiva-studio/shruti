import type { IDatabase } from "@ports/app/index.js"
import type { ChatSession } from "@lib/domain/chatSession.js"
import type { ChatSessionId, TrackId } from "@lib/domain/core.js"
import type {
  CreateChatSessionInput,
  IChatSessionRepository,
} from "@lib/domain/ports/chatSessionRepository.js"
import { mutate, queryMany, queryOne } from "@kit/persistence"

interface ChatSessionRow {
  readonly id: string
  readonly title: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly track_id: string | null
}

function rowToSession(r: ChatSessionRow): ChatSession {
  return {
    id: r.id as ChatSessionId,
    title: r.title,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    trackId: r.track_id ? (r.track_id as TrackId) : null,
  }
}

export function createSqlChatSessionRepository(db: IDatabase): IChatSessionRepository {
  return {
    async list(limit = 200): Promise<readonly ChatSession[]> {
      // Only surface a session once it has at least one VISIBLE message.
      // Proactive sessions are minted ahead of time (a holiday/weekly row
      // can be created 12–48h before its `visible_at`, with an empty body
      // still being prepped), but the session row itself carries no
      // visibility metadata — that lives on the message's proactive
      // sidecar. Without this EXISTS gate the session leaks into the
      // history list early, and tapping it opens an empty chat because
      // `listBySession` (correctly) hides the not-yet-visible message.
      // Mirror that exact gate here so a proactive session appears in the
      // list at the same moment its message becomes readable — which is
      // what `visible_at` was introduced for. Regular sessions have
      // messages with no sidecar row (`p.*` NULL → admitted), so they are
      // unaffected; truly empty sessions stay out of history.
      //
      // Ordered by the newest visible message, not by `updated_at` alone.
      // `updated_at` is bumped by `touch` on every completed turn, and `touch`
      // is deliberately NOT journaled to the sync outbox (see
      // syncJournalDecorator) — the wire snapshot for a session is pushed at
      // its first message and again at its title, so on every OTHER device the
      // column is frozen near the conversation's birth. Sorting on it there
      // put a conversation used daily since January below one abandoned in
      // June. The messages themselves ARE synced, so their `created_at` is the
      // same fact on every device and costs no extra sync traffic to carry.
      // `MAX(...)` keeps `updated_at` in play for the rare bump with no
      // message behind it, and the message side reuses the visibility gate
      // below so a not-yet-visible proactive row can't float a session.
      return queryMany<ChatSessionRow, ChatSession>(
        db,
        `SELECT s.id, s.title, s.created_at, s.updated_at, s.track_id,
                MAX(s.updated_at, COALESCE((
                  SELECT MAX(m.created_at)
                    FROM chat_messages m
                    LEFT JOIN chat_messages_proactive_state p
                      ON p.chat_message_id = m.id
                   WHERE m.session_id = s.id
                     AND (p.visible_at IS NULL OR p.visible_at <= unixepoch('now'))
                     AND (p.prep_state IS NULL OR p.prep_state IN ('ready','degraded'))
                ), 0)) AS sort_at
           FROM chat_sessions s
          WHERE EXISTS (
                  SELECT 1
                    FROM chat_messages m
                    LEFT JOIN chat_messages_proactive_state p
                      ON p.chat_message_id = m.id
                   WHERE m.session_id = s.id
                     AND (p.visible_at IS NULL OR p.visible_at <= unixepoch('now'))
                     AND (p.prep_state IS NULL OR p.prep_state IN ('ready','degraded'))
                )
          ORDER BY sort_at DESC
          LIMIT ?`,
        [limit],
        rowToSession
      )
    },

    async getById(id: ChatSessionId): Promise<ChatSession | null> {
      return queryOne<ChatSessionRow, ChatSession>(
        db,
        `SELECT id, title, created_at, updated_at, track_id
           FROM chat_sessions WHERE id = ? LIMIT 1`,
        [id],
        rowToSession
      )
    },

    async create(input: CreateChatSessionInput): Promise<ChatSession> {
      const now = Date.now()
      const trackId = input.trackId ?? null
      await mutate(
        db,
        "INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id) VALUES (?, ?, ?, ?, ?)",
        [input.id, input.title, now, now, trackId]
      )
      return {
        id: input.id,
        title: input.title,
        createdAt: now,
        updatedAt: now,
        trackId,
      }
    },

    async updateTitle(id: ChatSessionId, title: string): Promise<void> {
      await mutate(db, "UPDATE chat_sessions SET title = ? WHERE id = ?", [title, id])
    },

    async touch(id: ChatSessionId, updatedAtMs: number): Promise<void> {
      await mutate(db, "UPDATE chat_sessions SET updated_at = ? WHERE id = ?", [updatedAtMs, id])
    },

    async delete(id: ChatSessionId): Promise<void> {
      await mutate(db, "DELETE FROM chat_sessions WHERE id = ?", [id])
    },

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM chat_sessions")
    },

    async findLatestByTrack(trackId: TrackId): Promise<ChatSession | null> {
      return queryOne<ChatSessionRow, ChatSession>(
        db,
        // Same reason as `list`: `updated_at` is frozen on every device but the
        // one the conversation was typed on, so "latest" has to be derived
        // from the messages, which do sync.
        `SELECT s.id, s.title, s.created_at, s.updated_at, s.track_id
           FROM chat_sessions s
          WHERE s.track_id = ?
          ORDER BY MAX(s.updated_at, COALESCE((
                    SELECT MAX(m.created_at) FROM chat_messages m
                     WHERE m.session_id = s.id
                  ), 0)) DESC
          LIMIT 1`,
        [trackId],
        rowToSession
      )
    },
  }
}

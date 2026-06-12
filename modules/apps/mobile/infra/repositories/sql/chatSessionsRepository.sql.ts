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
      return queryMany<ChatSessionRow, ChatSession>(
        db,
        `SELECT s.id, s.title, s.created_at, s.updated_at, s.track_id
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
          ORDER BY s.updated_at DESC
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
        `SELECT id, title, created_at, updated_at, track_id
           FROM chat_sessions
          WHERE track_id = ?
          ORDER BY updated_at DESC
          LIMIT 1`,
        [trackId],
        rowToSession
      )
    },
  }
}

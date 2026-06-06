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
      return queryMany<ChatSessionRow, ChatSession>(
        db,
        `SELECT id, title, created_at, updated_at, track_id
           FROM chat_sessions
          ORDER BY updated_at DESC
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

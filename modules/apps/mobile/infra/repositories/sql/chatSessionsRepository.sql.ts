import type { IDatabase } from "@ports/app/index.js"
import type { ChatSession } from "@lib/domain/chatSession.js"
import type { ChatSessionId } from "@lib/domain/core.js"
import type {
  CreateChatSessionInput,
  IChatSessionRepository,
} from "@lib/domain/ports/chatSessionRepository.js"

interface ChatSessionRow {
  readonly id: string
  readonly title: string | null
  readonly created_at: number
  readonly updated_at: number
}

function rowToSession(r: ChatSessionRow): ChatSession {
  return {
    id: r.id as ChatSessionId,
    title: r.title,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export function createSqlChatSessionRepository(db: IDatabase): IChatSessionRepository {
  return {
    async list(limit = 200): Promise<readonly ChatSession[]> {
      const rows = await db.query<ChatSessionRow>(
        `SELECT id, title, created_at, updated_at
           FROM chat_sessions
          ORDER BY updated_at DESC
          LIMIT ?`,
        [limit]
      )
      return rows.map(rowToSession)
    },

    async getById(id: ChatSessionId): Promise<ChatSession | null> {
      const rows = await db.query<ChatSessionRow>(
        `SELECT id, title, created_at, updated_at
           FROM chat_sessions WHERE id = ? LIMIT 1`,
        [id]
      )
      return rows[0] ? rowToSession(rows[0]) : null
    },

    async create(input: CreateChatSessionInput): Promise<ChatSession> {
      const now = Date.now()
      await db.execute(
        "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [input.id, input.title, now, now]
      )
      await db.save()
      return {
        id: input.id,
        title: input.title,
        createdAt: now,
        updatedAt: now,
      }
    },

    async updateTitle(id: ChatSessionId, title: string): Promise<void> {
      await db.execute("UPDATE chat_sessions SET title = ? WHERE id = ?", [title, id])
      await db.save()
    },

    async touch(id: ChatSessionId, updatedAtMs: number): Promise<void> {
      await db.execute("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", [updatedAtMs, id])
      await db.save()
    },

    async delete(id: ChatSessionId): Promise<void> {
      await db.execute("DELETE FROM chat_sessions WHERE id = ?", [id])
      await db.save()
    },

    async clearAll(): Promise<void> {
      await db.execute("DELETE FROM chat_sessions")
      await db.save()
    },
  }
}

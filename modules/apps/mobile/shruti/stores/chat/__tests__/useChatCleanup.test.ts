import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { IDatabase } from "@ports/app/index.js"
import type { IChatSessionRepository } from "@lib/domain/ports/index.js"
import { createInMemoryTestDatabase } from "@infra/repositories/sql/__tests__/testDb.js"
import { createReentrantUnitOfWork } from "@infra/repositories/sql/reentrantUnitOfWork.sql.js"
import { createSqlUnitOfWork } from "@infra/repositories/sql/unitOfWork.sql.js"
import { createSqlChatSessionRepository } from "@infra/repositories/sql/chatSessionsRepository.sql.js"
import { createSqlChatMessageRepository } from "@infra/repositories/sql/chatMessagesRepository.sql.js"
import type { ChatReadState } from "../useChatReadState.js"
import { clearChatHistory, deleteChatSession } from "@usecases/chat/deleteChats.js"
import { useChatCleanup } from "../useChatCleanup.js"

vi.mock("@shruti/chat/turnNotificationEvents.js", () => ({ emitTurnSettled: () => {} }))

/**
 * "Clear history" empties both chat tables together or not at all, over the
 * real repositories: a conversation must never survive without its messages,
 * nor messages without their conversation.
 */

let db: IDatabase

async function count(table: string): Promise<number> {
  const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return Number(rows[0]?.n ?? 0)
}

function readState(): ChatReadState {
  return {
    forgetUnseen: () => {},
    clearAnswerUnread: async () => {},
    clearLastSeen: async () => {},
    clearAll: async () => {},
  } as unknown as ChatReadState
}

function cleanupWith(sessions: IChatSessionRepository) {
  const unitOfWork = createReentrantUnitOfWork(db)
  const messages = createSqlChatMessageRepository(db, createSqlUnitOfWork(db))
  return useChatCleanup({
    sessions: ref([]),
    activeSessionId: ref(null),
    messages: ref([]),
    deleteSessionRecords: (id) => deleteChatSession(id, { sessions, messages, unitOfWork }),
    clearAllRecords: () => clearChatHistory({ sessions, messages, unitOfWork }),
    readState: readState(),
    readPending: async () => [],
    clearPendingRecords: async () => {},
    cancelAllStreams: () => {},
    cancelSuggestions: () => {},
  })
}

beforeEach(async () => {
  db = await createInMemoryTestDatabase()
  await db.execute(`CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, track_id TEXT
  )`)
  await db.execute(`CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL, created_at INTEGER NOT NULL,
    meta TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}'
  )`)
  await db.execute("INSERT INTO chat_sessions (id, created_at, updated_at) VALUES ('s1', 1, 1)")
  await db.execute(
    "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES ('m1', 's1', 'user', 'hi', 1)"
  )
})

describe("useChatCleanup.clearAll", () => {
  it("empties both chat tables", async () => {
    await cleanupWith(createSqlChatSessionRepository(db)).clearAll()

    expect(await count("chat_sessions")).toBe(0)
    expect(await count("chat_messages")).toBe(0)
  })

  it("keeps the messages when the sessions cannot be cleared", async () => {
    const sessions: IChatSessionRepository = {
      ...createSqlChatSessionRepository(db),
      clearAll: async () => {
        throw new Error("database is locked")
      },
    }

    await expect(cleanupWith(sessions).clearAll()).rejects.toThrow(/locked/)

    expect(await count("chat_sessions")).toBe(1)
    expect(await count("chat_messages")).toBe(1)
  })
})

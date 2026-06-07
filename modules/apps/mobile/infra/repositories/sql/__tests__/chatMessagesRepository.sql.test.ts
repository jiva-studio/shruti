import { beforeEach, describe, expect, it } from "vitest"
import type { ChatSessionId } from "@lib/domain/core.js"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlChatMessageRepository } from "../chatMessagesRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/**
 * Minimum schema for the message reader: chat_messages + the proactive
 * sidecar whose `prep_state` / `visible_at` gate visibility.
 */
async function setupSchema(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE chat_messages (
       id          TEXT PRIMARY KEY,
       session_id  TEXT NOT NULL,
       role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
       content     TEXT NOT NULL,
       created_at  INTEGER NOT NULL,
       meta        TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}'
     )`
  )
  await db.execute(
    `CREATE TABLE chat_messages_proactive_state (
       chat_message_id  TEXT    PRIMARY KEY,
       rule_kind        TEXT    NOT NULL,
       rule_date        TEXT    NOT NULL,
       prep_state       TEXT    NOT NULL,
       prepared_at      INTEGER,
       visible_at       INTEGER,
       notify           INTEGER NOT NULL DEFAULT 0,
       seen_at          INTEGER,
       UNIQUE(rule_kind, rule_date),
       FOREIGN KEY (chat_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
     )`
  )
}

async function insertMessage(
  db: IDatabase,
  id: string,
  sessionId: string,
  content: string,
  createdAt: number
): Promise<void> {
  await db.execute(
    "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)",
    [id, sessionId, content, createdAt]
  )
}

async function insertProactiveState(
  db: IDatabase,
  chatMessageId: string,
  prepState: string,
  ruleDate: string
): Promise<void> {
  await db.execute(
    `INSERT INTO chat_messages_proactive_state
       (chat_message_id, rule_kind, rule_date, prep_state)
     VALUES (?, 'holiday', ?, ?)`,
    [chatMessageId, ruleDate, prepState]
  )
}

describe("chatMessagesRepository — listBySession proactive visibility gate", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlChatMessageRepository>
  const SESSION = "session-a"

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await setupSchema(db)
    repo = createSqlChatMessageRepository(db)
  })

  it("admits regular (non-proactive) messages — no sidecar row", async () => {
    await insertMessage(db, "m-plain", SESSION, "hello", 1000)
    const rows = await repo.listBySession(SESSION as ChatSessionId)
    expect(rows.map((r) => r.id)).toEqual(["m-plain"])
  })

  it("hides a body-less pending proactive row so it never renders a blank bubble", async () => {
    await insertMessage(db, "m-pending", SESSION, "", 1000)
    await insertProactiveState(db, "m-pending", "pending", "2026-05-18")
    const rows = await repo.listBySession(SESSION as ChatSessionId)
    expect(rows).toHaveLength(0)
  })

  it("surfaces ready and degraded proactive rows", async () => {
    await insertMessage(db, "m-ready", SESSION, "ready body", 1000)
    await insertProactiveState(db, "m-ready", "ready", "2026-05-18")
    await insertMessage(db, "m-degraded", SESSION, "degraded body", 2000)
    await insertProactiveState(db, "m-degraded", "degraded", "2026-05-19")
    const rows = await repo.listBySession(SESSION as ChatSessionId)
    expect(rows.map((r) => r.id)).toEqual(["m-ready", "m-degraded"])
  })

  it("keeps dismissed and superseded rows hidden", async () => {
    await insertMessage(db, "m-dismissed", SESSION, "x", 1000)
    await insertProactiveState(db, "m-dismissed", "dismissed", "2026-05-18")
    await insertMessage(db, "m-superseded", SESSION, "y", 2000)
    await insertProactiveState(db, "m-superseded", "superseded", "2026-05-19")
    const rows = await repo.listBySession(SESSION as ChatSessionId)
    expect(rows).toHaveLength(0)
  })
})

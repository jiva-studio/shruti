import { beforeEach, describe, expect, it } from "vitest"
import type { ChatSessionId, TrackId } from "@lib/domain/core.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlChatSessionRepository } from "../chatSessionsRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/**
 * Issue #1741 (4): chat history was sorted by `chat_sessions.updated_at`, a
 * column that `syncJournalDecorator` deliberately never re-journals. Every
 * completed turn bumps it locally, but the wire snapshot is pushed only at the
 * session's first message and at its title — so on every OTHER device the
 * column is frozen near the conversation's birth, and a conversation used
 * daily since January sorted below one abandoned in June.
 *
 * The order is derived from the newest visible message instead. Those DO sync,
 * so it costs no extra outbox traffic and is the same fact on every device.
 */

async function setupSchema(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE chat_sessions (
       id          TEXT PRIMARY KEY,
       title       TEXT,
       created_at  INTEGER NOT NULL,
       updated_at  INTEGER NOT NULL,
       track_id    TEXT
     )`
  )
  await db.execute(
    `CREATE TABLE chat_messages (
       id          TEXT PRIMARY KEY,
       session_id  TEXT NOT NULL,
       role        TEXT NOT NULL,
       content     TEXT NOT NULL,
       created_at  INTEGER NOT NULL,
       meta        TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}'
     )`
  )
  await db.execute(
    `CREATE TABLE chat_messages_proactive_state (
       chat_message_id  TEXT PRIMARY KEY,
       rule_kind        TEXT NOT NULL,
       rule_date        TEXT NOT NULL,
       prep_state       TEXT NOT NULL,
       prepared_at      INTEGER,
       visible_at       INTEGER,
       notify           INTEGER NOT NULL DEFAULT 0,
       seen_at          INTEGER,
       scheduler_authored INTEGER NOT NULL DEFAULT 0
     )`
  )
}

const JANUARY = Date.UTC(2026, 0, 10)
const JUNE = Date.UTC(2026, 5, 10)
const AUGUST = Date.UTC(2026, 7, 10)

/** A session as a SECOND device sees it after a pull: the snapshot it received
 *  carries the `updated_at` of the moment the session entered sync, because
 *  `touch` is never journaled afterwards. */
async function insertSession(
  db: IDatabase,
  id: string,
  updatedAt: number,
  trackId: string | null = null
): Promise<void> {
  await db.execute(
    "INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id) VALUES (?, ?, ?, ?, ?)",
    [id, id, updatedAt, updatedAt, trackId]
  )
}

async function insertMessage(
  db: IDatabase,
  id: string,
  sessionId: string,
  createdAt: number
): Promise<void> {
  await db.execute(
    "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', 'q', ?)",
    [id, sessionId, createdAt]
  )
}

describe("chatSessionsRepository.list — history order across devices", () => {
  let db: IDatabase
  let repo: IChatSessionRepository

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await setupSchema(db)
    repo = createSqlChatSessionRepository(db)
  })

  it("ranks a conversation by its newest message, not by the stale updated_at", async () => {
    // Both sessions were born in January; only "abandoned" was still being
    // used in June as far as the SYNCED `updated_at` column knows.
    await insertSession(db, "daily", JANUARY)
    await insertSession(db, "abandoned", JUNE)
    await insertMessage(db, "m-daily-1", "daily", JANUARY)
    // …but the daily conversation's August messages arrived on this device.
    await insertMessage(db, "m-daily-2", "daily", AUGUST)
    await insertMessage(db, "m-abandoned", "abandoned", JUNE)

    const list = await repo.list()
    expect(list.map((s) => s.id)).toEqual(["daily", "abandoned"])
  })

  it("keeps updated_at in play when nothing newer was ever written", async () => {
    await insertSession(db, "older", JANUARY)
    await insertSession(db, "newer", JUNE)
    await insertMessage(db, "m-older", "older", JANUARY)
    await insertMessage(db, "m-newer", "newer", JUNE)

    const list = await repo.list()
    expect(list.map((s) => s.id)).toEqual(["newer", "older"])
  })

  it("does not let a not-yet-visible proactive message float a session", async () => {
    await insertSession(db, "real", JUNE)
    await insertSession(db, "proactive", JANUARY)
    await insertMessage(db, "m-real", "real", JUNE)
    await insertMessage(db, "m-proactive-visible", "proactive", JANUARY)
    // A holiday row prepared ahead of time, dated in the future.
    await insertMessage(db, "m-proactive-future", "proactive", AUGUST)
    await db.execute(
      `INSERT INTO chat_messages_proactive_state
         (chat_message_id, rule_kind, rule_date, prep_state, visible_at)
       VALUES ('m-proactive-future', 'holiday', '2026-08-10', 'ready', ?)`,
      [Math.floor(AUGUST / 1000) + 365 * 24 * 3600]
    )

    const list = await repo.list()
    expect(list.map((s) => s.id)).toEqual(["real", "proactive"])
  })

  it("picks the track's latest conversation by its newest message too", async () => {
    await insertSession(db, "old-chat", JUNE, "t1")
    await insertSession(db, "live-chat", JANUARY, "t1")
    await insertMessage(db, "m-old", "old-chat", JUNE)
    await insertMessage(db, "m-live", "live-chat", AUGUST)

    const found = await repo.findLatestByTrack("t1" as TrackId)
    expect(found?.id).toBe("live-chat" as ChatSessionId)
  })
})

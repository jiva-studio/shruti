import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createInMemoryTestDatabase, applyUserSchemaForTests } from "./testDb.js"
import { createSqlSyncBackfillRepository } from "../syncBackfillRepository.sql.js"

/**
 * SQL-level tests for the first-sync backfill adapter, focused on the
 * `listening_sessions` track attribution.
 *
 * Regression guard: the backfill session snapshot used to ship the raw row and
 * omit `track_id` (while the live journal + apply paths resolved it), so every
 * backfilled session lost its track attribution on the server. The use-case
 * test (`backfillLocal.test.ts`) runs against a fake and never exercised this
 * JOIN, which is exactly how the bug slipped through — hence a real sql.js DB
 * here.
 */
async function withSyncTables(db: IDatabase): Promise<void> {
  await applyUserSchemaForTests(db)
  // The backfill anti-join reads these two; the schema helper doesn't create
  // them (they're sync-lane tables).
  await db.execute(
    `CREATE TABLE outbox (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       collection TEXT NOT NULL, doc_id TEXT NOT NULL, op TEXT NOT NULL,
       data TEXT, hlc TEXT NOT NULL, base_hlc TEXT,
       created_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0
     )`
  )
  await db.execute(
    `CREATE TABLE sync_doc_hlc (
       collection TEXT NOT NULL, doc_id TEXT NOT NULL, server_hlc TEXT NOT NULL,
       PRIMARY KEY (collection, doc_id)
     )`
  )
  // Chat lane tables (migrations 007 / 008 / 009), enough for the backfill scan.
  await db.execute(
    `CREATE TABLE chat_sessions (
       id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL, track_id TEXT
     )`
  )
  await db.execute(
    `CREATE TABLE chat_messages (
       id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
       role TEXT NOT NULL CHECK(role IN ('user','assistant')),
       content TEXT NOT NULL, created_at INTEGER NOT NULL,
       meta TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}',
       FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
     )`
  )
  await db.execute(
    `CREATE TABLE chat_messages_proactive_state (
       chat_message_id TEXT PRIMARY KEY, rule_kind TEXT NOT NULL,
       rule_date TEXT NOT NULL, prep_state TEXT NOT NULL, prepared_at INTEGER,
       visible_at INTEGER, notify INTEGER NOT NULL DEFAULT 0, seen_at INTEGER,
       scheduler_authored INTEGER NOT NULL DEFAULT 0
     )`
  )
}

describe("createSqlSyncBackfillRepository — listening_sessions", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await withSyncTables(db)
  })

  it("resolves track_id from the playlist item (regression: backfill used to drop it)", async () => {
    await db.execute(
      "INSERT INTO playlist_items (id, track_id, added_at, archived_at) VALUES ('pl_1', 'track-77', 1, NULL)"
    )
    // Exclude the playlist item from being its own candidate so the result is
    // just the session — the JOIN still resolves it in `playlist_items`.
    await db.execute(
      "INSERT INTO sync_doc_hlc (collection, doc_id, server_hlc) VALUES ('playlist_items', 'track-77', 'h')"
    )
    await db.execute(
      `INSERT INTO listening_sessions (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_1', 'pl_1', 10, 20, 0, 30)`
    )

    const out = await createSqlSyncBackfillRepository(db).listUnsynced()

    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      collection: "listening_sessions",
      docId: "ls_1",
      data: {
        id: "ls_1",
        item_id: "pl_1",
        track_id: "track-77",
        started_at: 10,
        ended_at: 20,
        from_position: 0,
        to_position: 30,
      },
    })
  })

  it("emits track_id: null when the playlist item is gone (attribution unrecoverable)", async () => {
    await db.execute(
      `INSERT INTO listening_sessions (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_2', 'pl_missing', 10, 20, 0, 30)`
    )

    const out = await createSqlSyncBackfillRepository(db).listUnsynced()
    const session = out.find((c) => c.collection === "listening_sessions")

    expect(session?.data).toMatchObject({ id: "ls_2", item_id: "pl_missing", track_id: null })
  })
})

describe("createSqlSyncBackfillRepository — chat", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await withSyncTables(db)
  })

  it("backfills a session with a user-initiated message, session before message", async () => {
    await db.execute(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id) VALUES ('cs_1', 'T', 1, 2, NULL)"
    )
    await db.execute(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, meta)
       VALUES ('cm_1', 'cs_1', 'user', 'hi', 3, '{"_v":1,"data":{}}')`
    )

    const out = await createSqlSyncBackfillRepository(db).listUnsynced()

    const cols = out.map((c) => c.collection)
    // Parent-before-child: the session precedes its message in the candidate list.
    expect(cols.indexOf("chat_sessions")).toBeLessThan(cols.indexOf("chat_messages"))
    expect(out.find((c) => c.collection === "chat_sessions")).toEqual({
      collection: "chat_sessions",
      docId: "cs_1",
      data: { id: "cs_1", title: "T", created_at: 1, updated_at: 2, track_id: null },
    })
    expect(out.find((c) => c.collection === "chat_messages")).toEqual({
      collection: "chat_messages",
      docId: "cm_1",
      data: {
        id: "cm_1",
        session_id: "cs_1",
        role: "user",
        content: "hi",
        created_at: 3,
        meta: '{"_v":1,"data":{}}',
      },
    })
  })

  it("excludes a proactive-only session and its proactive message", async () => {
    await db.execute(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id) VALUES ('cs_p', NULL, 1, 2, NULL)"
    )
    await db.execute(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, meta)
       VALUES ('cm_p', 'cs_p', 'assistant', 'proactive', 3, '{"_v":1,"data":{}}')`
    )
    await db.execute(
      `INSERT INTO chat_messages_proactive_state (chat_message_id, rule_kind, rule_date, prep_state, prepared_at, scheduler_authored)
       VALUES ('cm_p', 'daily', '2026-07-07', 'ready', 4, 1)`
    )

    const out = await createSqlSyncBackfillRepository(db).listUnsynced()

    expect(out.some((c) => c.collection.startsWith("chat"))).toBe(false)
  })

  it("keeps user messages but drops proactive ones within a mixed session", async () => {
    await db.execute(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id) VALUES ('cs_m', NULL, 1, 2, NULL)"
    )
    await db.execute(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, meta)
       VALUES ('cm_u', 'cs_m', 'user', 'q', 3, '{"_v":1,"data":{}}'),
              ('cm_pr', 'cs_m', 'assistant', 'nudge', 4, '{"_v":1,"data":{}}')`
    )
    await db.execute(
      `INSERT INTO chat_messages_proactive_state (chat_message_id, rule_kind, rule_date, prep_state, prepared_at, scheduler_authored)
       VALUES ('cm_pr', 'daily', '2026-07-07', 'ready', 5, 1)`
    )

    const out = await createSqlSyncBackfillRepository(db).listUnsynced()
    const msgIds = out.filter((c) => c.collection === "chat_messages").map((c) => c.docId)

    expect(msgIds).toEqual(["cm_u"])
    // The session still backfills (it carries a user-initiated message).
    expect(out.some((c) => c.collection === "chat_sessions" && c.docId === "cs_m")).toBe(true)
  })

  it("backfills an ordinary answer that carries an inline-hint cooldown (attach, scheduler_authored=0)", async () => {
    // Regression: an inline-hint cooldown (`proactiveState.attach`) stamps a
    // proactive_state row onto a REAL assistant answer. It must NOT disqualify
    // the message — dropping it lost half the conversation on the wire.
    await db.execute(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id) VALUES ('cs_h', NULL, 1, 2, NULL)"
    )
    await db.execute(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, meta)
       VALUES ('cm_q', 'cs_h', 'user', 'question', 3, '{"_v":1,"data":{}}'),
              ('cm_a', 'cs_h', 'assistant', 'the real answer', 4, '{"_v":1,"data":{}}')`
    )
    // Inline-hint attach on the ASSISTANT answer: visible_at NULL, notify 0,
    // seen_at set, scheduler_authored 0 — exactly what `attach()` writes.
    await db.execute(
      `INSERT INTO chat_messages_proactive_state
         (chat_message_id, rule_kind, rule_date, prep_state, prepared_at, visible_at, notify, seen_at, scheduler_authored)
       VALUES ('cm_a', 'enable_notifications_hint', '2026-07-07', 'ready', 5, NULL, 0, 5, 0)`
    )

    const out = await createSqlSyncBackfillRepository(db).listUnsynced()
    const msgIds = out
      .filter((c) => c.collection === "chat_messages")
      .map((c) => c.docId)
      .sort()

    // BOTH the question and the real answer sync — the hint cooldown is invisible to backfill.
    expect(msgIds).toEqual(["cm_a", "cm_q"])
    expect(out.some((c) => c.collection === "chat_sessions" && c.docId === "cs_h")).toBe(true)
  })

  it("skips all chat when the Sync-chats toggle is off", async () => {
    await db.execute(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id) VALUES ('cs_1', 'T', 1, 2, NULL)"
    )
    await db.execute(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, meta)
       VALUES ('cm_1', 'cs_1', 'user', 'hi', 3, '{"_v":1,"data":{}}')`
    )

    const out = await createSqlSyncBackfillRepository(db, () => false).listUnsynced()

    expect(out.some((c) => c.collection.startsWith("chat"))).toBe(false)
  })

  it("does not re-enqueue chat rows that already own an outbox entry", async () => {
    await db.execute(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id) VALUES ('cs_1', 'T', 1, 2, NULL)"
    )
    await db.execute(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, meta)
       VALUES ('cm_1', 'cs_1', 'user', 'hi', 3, '{"_v":1,"data":{}}')`
    )
    await db.execute(
      `INSERT INTO outbox (collection, doc_id, op, data, hlc, base_hlc, created_at, sent)
       VALUES ('chat_sessions', 'cs_1', 'upsert', '{}', 'h1', NULL, 1, 0),
              ('chat_messages', 'cm_1', 'upsert', '{}', 'h2', NULL, 1, 0)`
    )

    const out = await createSqlSyncBackfillRepository(db).listUnsynced()

    expect(out.some((c) => c.collection.startsWith("chat"))).toBe(false)
  })
})

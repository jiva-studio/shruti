import { beforeEach, describe, expect, it } from "vitest"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlProactiveStateRepository } from "../proactiveStateRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/**
 * Apply the minimum schema this repo touches: chat_sessions /
 * chat_messages (cols proactive cares about) + the sidecar with the
 * new `seen_at` column from migration 010.
 */
async function setupSchema(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE chat_sessions (
       id          TEXT PRIMARY KEY,
       title       TEXT,
       created_at  INTEGER NOT NULL,
       updated_at  INTEGER NOT NULL,
       title_attempt_count INTEGER NOT NULL DEFAULT 0
     )`
  )
  await db.execute(
    `CREATE TABLE chat_messages (
       id          TEXT PRIMARY KEY,
       session_id  TEXT NOT NULL,
       role        TEXT NOT NULL,
       content     TEXT NOT NULL,
       created_at  INTEGER NOT NULL,
       actions_json       TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}',
       outlines_json      TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}',
       action_states_json TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}',
       error       TEXT,
       visible_on  TEXT,
       notify_at   INTEGER,
       notified_at INTEGER,
       FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
     )`
  )
  await db.execute(
    `CREATE TABLE chat_messages_proactive_state (
       chat_message_id  TEXT    PRIMARY KEY,
       rule_kind        TEXT    NOT NULL,
       rule_date        TEXT    NOT NULL,
       prep_state       TEXT    NOT NULL,
       prepared_at      INTEGER,
       seen_at          INTEGER,
       UNIQUE(rule_kind, rule_date),
       FOREIGN KEY (chat_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
     )`
  )
}

async function seedSession(
  db: IDatabase,
  sessionId: string,
  now: number = Date.now()
): Promise<void> {
  await db.execute("INSERT INTO chat_sessions (id, created_at, updated_at) VALUES (?, ?, ?)", [
    sessionId,
    now,
    now,
  ])
}

describe("proactiveStateRepository — seen_at semantics", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlProactiveStateRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await setupSchema(db)
    repo = createSqlProactiveStateRepository(db)
  })

  it("create() inserts with seen_at = NULL", async () => {
    await seedSession(db, "session-a")
    const entry = await repo.create({
      chatMessageId: "msg-1" as ChatMessageId,
      sessionId: "session-a" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleOn: "2026-05-18",
      notifyAt: null,
      ruleKind: "holiday",
      ruleDate: "2026-05-18",
      prepState: "pending",
    })
    expect(entry).not.toBeNull()
    expect(entry!.seenAt).toBeNull()
  })

  it("attach() inserts with seen_at = now (inline hints are already-seen)", async () => {
    await seedSession(db, "session-b")
    // Insert a chat_messages row directly — attach assumes one exists.
    await db.execute(
      "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ["msg-attach", "session-b", "assistant", "body with marker", 1700000000000]
    )
    await repo.attach(
      "msg-attach" as ChatMessageId,
      "enable_notifications_hint",
      "2026-05-18",
      "ready"
    )
    const row = await db.query<{ seen_at: number | null }>(
      "SELECT seen_at FROM chat_messages_proactive_state WHERE chat_message_id = ?",
      ["msg-attach"]
    )
    expect(row[0].seen_at).not.toBeNull()
    expect(typeof row[0].seen_at).toBe("number")
  })

  it("listUnseenSessionIds returns only sessions with NULL seen_at AND ready/degraded prep_state", async () => {
    await seedSession(db, "session-unseen-ready")
    await seedSession(db, "session-unseen-pending")
    await seedSession(db, "session-already-seen")

    // ready + unseen → should appear
    await repo.create({
      chatMessageId: "m-r" as ChatMessageId,
      sessionId: "session-unseen-ready" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleOn: null,
      notifyAt: null,
      ruleKind: "holiday",
      ruleDate: "2026-05-18",
      prepState: "ready",
    })

    // pending + unseen → should NOT appear (body still being built)
    await repo.create({
      chatMessageId: "m-p" as ChatMessageId,
      sessionId: "session-unseen-pending" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleOn: null,
      notifyAt: null,
      ruleKind: "weekly_digest",
      ruleDate: "2026-05-18",
      prepState: "pending",
    })

    // ready + seen → should NOT appear
    await repo.create({
      chatMessageId: "m-s" as ChatMessageId,
      sessionId: "session-already-seen" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleOn: null,
      notifyAt: null,
      ruleKind: "inactivity",
      ruleDate: "2026-05-18",
      prepState: "ready",
    })
    await repo.markSeen("session-already-seen" as ChatSessionId, 1700000001)

    const unseen = await repo.listUnseenSessionIds()
    expect(unseen).toEqual(["session-unseen-ready"])
  })

  it("markSeen is idempotent — second call doesn't overwrite the earlier timestamp", async () => {
    await seedSession(db, "session-c")
    await repo.create({
      chatMessageId: "msg-c" as ChatMessageId,
      sessionId: "session-c" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleOn: null,
      notifyAt: null,
      ruleKind: "holiday",
      ruleDate: "2026-05-18",
      prepState: "ready",
    })
    await repo.markSeen("session-c" as ChatSessionId, 1700000100)
    await repo.markSeen("session-c" as ChatSessionId, 1700000200)
    const row = await db.query<{ seen_at: number }>(
      "SELECT seen_at FROM chat_messages_proactive_state WHERE chat_message_id = ?",
      ["msg-c"]
    )
    expect(row[0].seen_at).toBe(1700000100)
  })

  it("markSeen scoped to one session leaves others untouched", async () => {
    await seedSession(db, "session-x")
    await seedSession(db, "session-y")
    await repo.create({
      chatMessageId: "msg-x" as ChatMessageId,
      sessionId: "session-x" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleOn: null,
      notifyAt: null,
      ruleKind: "holiday",
      ruleDate: "2026-05-18",
      prepState: "ready",
    })
    await repo.create({
      chatMessageId: "msg-y" as ChatMessageId,
      sessionId: "session-y" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleOn: null,
      notifyAt: null,
      ruleKind: "weekly_digest",
      ruleDate: "2026-05-18",
      prepState: "ready",
    })
    await repo.markSeen("session-x" as ChatSessionId, 1700000100)
    const unseen = await repo.listUnseenSessionIds()
    expect(unseen).toEqual(["session-y"])
  })
})

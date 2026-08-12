import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlProactiveStateRepository } from "../proactiveStateRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/** Stands in for the journaled `chatMessages` repository the composition root
 *  injects — deletes for real, and records the calls so a test can assert the
 *  sweep went through the tombstoning path rather than raw SQL. */
function chatMessagesStub(db: IDatabase): {
  delete: (id: ChatMessageId) => Promise<void>
  deleted: ChatMessageId[]
} {
  const deleted: ChatMessageId[] = []
  return {
    deleted,
    delete: vi.fn(async (id: ChatMessageId) => {
      deleted.push(id)
      await db.execute("DELETE FROM chat_messages WHERE id = ?", [id])
    }),
  }
}

/**
 * Apply the minimum schema this repo touches: chat_sessions /
 * chat_messages (cols proactive cares about) + the sidecar holding
 * the proactive bookkeeping (`visible_at`, `notify`, `seen_at`).
 */
async function setupSchema(db: IDatabase): Promise<void> {
  // Mirror the real user.db: the sidecar's cascade only fires with FKs on.
  await db.execute("PRAGMA foreign_keys = ON")
  await db.execute(
    `CREATE TABLE chat_sessions (
       id          TEXT PRIMARY KEY,
       title       TEXT,
       created_at  INTEGER NOT NULL,
       updated_at  INTEGER NOT NULL
     )`
  )
  await db.execute(
    `CREATE TABLE chat_messages (
       id          TEXT PRIMARY KEY,
       session_id  TEXT NOT NULL,
       role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
       content     TEXT NOT NULL,
       created_at  INTEGER NOT NULL,
       meta        TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}',
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
       visible_at       INTEGER,
       notify           INTEGER NOT NULL DEFAULT 0,
       seen_at          INTEGER,
       scheduler_authored INTEGER NOT NULL DEFAULT 0,
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
    repo = createSqlProactiveStateRepository(db, { chatMessages: chatMessagesStub(db) })
  })

  it("create() inserts with seen_at = NULL", async () => {
    await seedSession(db, "session-a")
    const entry = await repo.create({
      chatMessageId: "msg-1" as ChatMessageId,
      sessionId: "session-a" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleAt: 1700000000,
      notify: false,
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
      visibleAt: null,
      notify: false,
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
      visibleAt: null,
      notify: false,
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
      visibleAt: null,
      notify: false,
      ruleKind: "inactivity",
      ruleDate: "2026-05-18",
      prepState: "ready",
    })
    await repo.markSeen("session-already-seen" as ChatSessionId, 1700000001)

    const unseen = await repo.listUnseenSessionIds()
    expect(unseen).toEqual(["session-unseen-ready"])
  })

  it("listUnseenSessionIds hides ready+unseen rows whose visible_at is still in the future", async () => {
    await seedSession(db, "session-now")
    await seedSession(db, "session-future")

    const nowSec = Math.floor(Date.now() / 1000)

    // ready + unseen + already visible → should appear
    await repo.create({
      chatMessageId: "m-now" as ChatMessageId,
      sessionId: "session-now" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleAt: nowSec - 3600,
      notify: false,
      ruleKind: "holiday",
      ruleDate: "2026-05-18",
      prepState: "ready",
    })

    // ready + unseen but visible_at an hour out → must NOT light the
    // badge yet (the message itself is still gated out of the thread by
    // listBySession), even though prep already finished.
    await repo.create({
      chatMessageId: "m-future" as ChatMessageId,
      sessionId: "session-future" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleAt: nowSec + 3600,
      notify: true,
      ruleKind: "weekly_digest",
      ruleDate: "2026-05-19",
      prepState: "ready",
    })

    const unseen = await repo.listUnseenSessionIds()
    expect(unseen).toEqual(["session-now"])
  })

  it("markSeen is idempotent — second call doesn't overwrite the earlier timestamp", async () => {
    await seedSession(db, "session-c")
    await repo.create({
      chatMessageId: "msg-c" as ChatMessageId,
      sessionId: "session-c" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleAt: null,
      notify: false,
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

  it("create() dedups on (rule_kind, rule_date): second call returns null and leaves no orphan message", async () => {
    await seedSession(db, "session-first")
    await seedSession(db, "session-dup")

    const first = await repo.create({
      chatMessageId: "msg-first" as ChatMessageId,
      sessionId: "session-first" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000000000,
      visibleAt: null,
      notify: false,
      ruleKind: "weekly_digest",
      ruleDate: "2026-06-07",
      prepState: "pending",
    })
    expect(first).not.toBeNull()

    // Same (ruleKind, ruleDate) but a different chatMessageId/session —
    // ON CONFLICT DO NOTHING must keep the original and report the dedup.
    const dup = await repo.create({
      chatMessageId: "msg-dup" as ChatMessageId,
      sessionId: "session-dup" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 1700000005000,
      visibleAt: null,
      notify: false,
      ruleKind: "weekly_digest",
      ruleDate: "2026-06-07",
      prepState: "pending",
    })
    expect(dup).toBeNull()

    // The losing call must not leave an orphan chat_messages row behind.
    const orphan = await db.query<{ id: string }>("SELECT id FROM chat_messages WHERE id = ?", [
      "msg-dup",
    ])
    expect(orphan).toHaveLength(0)

    // The original proactive_state row is still the one that owns the slot.
    const owner = await db.query<{ chat_message_id: string }>(
      "SELECT chat_message_id FROM chat_messages_proactive_state WHERE rule_kind = ? AND rule_date = ?",
      ["weekly_digest", "2026-06-07"]
    )
    expect(owner).toHaveLength(1)
    expect(owner[0].chat_message_id).toBe("msg-first")
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
      visibleAt: null,
      notify: false,
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
      visibleAt: null,
      notify: false,
      ruleKind: "weekly_digest",
      ruleDate: "2026-05-18",
      prepState: "ready",
    })
    await repo.markSeen("session-x" as ChatSessionId, 1700000100)
    const unseen = await repo.listUnseenSessionIds()
    expect(unseen).toEqual(["session-y"])
  })
})

/**
 * The sidecar table has two tenants (#1770): proactive bodies the scheduler
 * authored and owns (`scheduler_authored = 1`), and inline-hint cooldown
 * markers `attach`ed to ordinary assistant answers (`scheduler_authored = 0`).
 * Every reader that acts on a row — the prep loop's list, the unseen badge,
 * the 90-day sweep — has to tell them apart, or it hides, rewrites or deletes
 * an answer the user asked for.
 */
describe("proactiveStateRepository — the two tenants of the sidecar table", () => {
  let db: IDatabase
  let chatMessages: ReturnType<typeof chatMessagesStub>
  let repo: ReturnType<typeof createSqlProactiveStateRepository>

  const OLD_MS = 1_600_000_000_000
  const CUTOFF_SEC = 1_700_000_000

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await setupSchema(db)
    chatMessages = chatMessagesStub(db)
    repo = createSqlProactiveStateRepository(db, { chatMessages })
  })

  /** A real answer written by the normal chat flow, plus the cooldown marker
   *  the inline hint attaches to it. */
  async function seedAnsweredTurn(id: string, prepState: string): Promise<void> {
    await seedSession(db, `s-${id}`)
    await db.execute(
      "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', 'a question', ?)",
      [`${id}-q`, `s-${id}`, OLD_MS]
    )
    await db.execute(
      "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', 'the real answer', ?)",
      [id, `s-${id}`, OLD_MS]
    )
    await repo.attach(id as ChatMessageId, "enable_notifications_hint", `2020-09-13`, "ready")
    await db.execute(
      "UPDATE chat_messages_proactive_state SET prep_state = ? WHERE chat_message_id = ?",
      [prepState, id]
    )
  }

  async function seedSchedulerRow(id: string, ruleDate: string, prepState: string): Promise<void> {
    await seedSession(db, `s-${id}`)
    await repo.create({
      chatMessageId: id as ChatMessageId,
      sessionId: `s-${id}` as ChatSessionId,
      role: "assistant",
      content: "holiday digest",
      createdAt: OLD_MS,
      visibleAt: null,
      notify: false,
      ruleKind: "holiday",
      ruleDate,
      prepState: "ready",
    })
    await db.execute(
      "UPDATE chat_messages_proactive_state SET prep_state = ? WHERE chat_message_id = ?",
      [prepState, id]
    )
  }

  async function messageIds(): Promise<string[]> {
    const rows = await db.query<{ id: string }>("SELECT id FROM chat_messages ORDER BY id")
    return rows.map((r) => r.id)
  }

  async function sidecarIds(): Promise<string[]> {
    const rows = await db.query<{ chat_message_id: string }>(
      "SELECT chat_message_id FROM chat_messages_proactive_state ORDER BY chat_message_id"
    )
    return rows.map((r) => r.chat_message_id)
  }

  it("listByPrepStates never hands a cooldown marker to the prep loop", async () => {
    await seedAnsweredTurn("m-answer", "ready")
    await seedSchedulerRow("m-proactive", "2026-05-18", "ready")

    const live = await repo.listByPrepStates(["pending", "ready", "degraded"])
    expect(live.map((e) => e.chatMessageId)).toEqual(["m-proactive"])
  })

  it("listUnseenSessionIds ignores cooldown markers", async () => {
    await seedAnsweredTurn("m-answer", "ready")
    await db.execute("UPDATE chat_messages_proactive_state SET seen_at = NULL")

    expect(await repo.listUnseenSessionIds()).toEqual([])
  })

  it("sweepTerminal drops a terminal cooldown marker but KEEPS its host answer", async () => {
    await seedAnsweredTurn("m-answer", "superseded")

    expect(await repo.sweepTerminal(CUTOFF_SEC)).toBe(1)
    expect(await messageIds()).toEqual(["m-answer", "m-answer-q"])
    expect(await sidecarIds()).toEqual([])
    expect(chatMessages.deleted).toEqual([])
  })

  it("sweepTerminal still removes terminal scheduler-authored messages, via the journaled repo", async () => {
    await seedSchedulerRow("m-dismissed", "2026-05-18", "dismissed")
    await seedSchedulerRow("m-superseded", "2026-05-19", "superseded")
    await seedSchedulerRow("m-ready", "2026-05-20", "ready")

    expect(await repo.sweepTerminal(CUTOFF_SEC)).toBe(2)
    // Routed through chatMessages.delete — that is what emits the sync
    // tombstone; a raw DELETE leaves every other device holding the message.
    expect(chatMessages.deleted.sort()).toEqual(["m-dismissed", "m-superseded"])
    expect(await messageIds()).toEqual(["m-ready"])
    expect(await sidecarIds()).toEqual(["m-ready"])
  })

  it("leaves rows newer than the cutoff alone", async () => {
    await seedSchedulerRow("m-fresh", "2026-05-18", "dismissed")
    expect(await repo.sweepTerminal(1_500_000_000)).toBe(0)
    expect(await messageIds()).toEqual(["m-fresh"])
  })
})

describe("proactiveStateRepository — prepared_at is unix milliseconds", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlProactiveStateRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await setupSchema(db)
    repo = createSqlProactiveStateRepository(db, { chatMessages: chatMessagesStub(db) })
  })

  it("stores what attach() was given, unscaled", async () => {
    await seedSession(db, "s-attach")
    await db.execute(
      "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES ('m-a', 's-attach', 'assistant', 'answer', 1700000000000)"
    )
    await repo.attach(
      "m-a" as ChatMessageId,
      "enable_notifications_hint",
      "2023-11-14",
      "ready",
      1_700_000_000_000
    )
    const entry = await repo.findByRuleAndDate("enable_notifications_hint", "2023-11-14")
    expect(entry?.preparedAt).toBe(1_700_000_000_000)
  })

  // Pre-028 installs carry seconds-magnitude stamps. Reading one back as-is
  // makes the row look ~55 years old, so `refresh_if_older_than_hours` can
  // never hold and the scheduler rebuilds the body over and over.
  it("reads a legacy seconds-magnitude stamp back as milliseconds", async () => {
    await seedSession(db, "s-legacy")
    await db.execute(
      "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES ('m-l', 's-legacy', 'assistant', 'answer', 1700000000000)"
    )
    await db.execute(
      `INSERT INTO chat_messages_proactive_state
         (chat_message_id, rule_kind, rule_date, prep_state, prepared_at, notify, scheduler_authored)
       VALUES ('m-l', 'smart_library_hint', '2023-11-14', 'ready', 1700000000, 0, 0)`
    )
    const entry = await repo.findByRuleAndDate("smart_library_hint", "2023-11-14")
    expect(entry?.preparedAt).toBe(1_700_000_000_000)
  })
})

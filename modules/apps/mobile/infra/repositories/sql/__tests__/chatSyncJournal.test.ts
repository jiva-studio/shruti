import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import { createInMemoryTestDatabase } from "./testDb.js"
import { createReentrantUnitOfWork } from "../reentrantUnitOfWork.sql.js"
import { createSqlChatSessionRepository } from "../chatSessionsRepository.sql.js"
import { createSqlChatMessageRepository } from "../chatMessagesRepository.sql.js"
import { createSqlProactiveStateRepository } from "../proactiveStateRepository.sql.js"
import { withSyncJournaling } from "../syncJournalDecorator.js"

/**
 * Integration test for chat journaling (Lane G): the sync-journal decorator
 * over the REAL chat repositories on an in-memory sql.js DB. Proves the gate,
 * user-initiated-only exclusion, completed-only journaling, parent-before-child
 * ordering, and the tombstone-only-for-synced-sessions rule.
 */

interface OutboxRow {
  id: number
  collection: string
  doc_id: string
  op: string
  data: string | null
}

async function applySchema(db: IDatabase): Promise<void> {
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
  await db.execute(`CREATE TABLE chat_messages_proactive_state (
    chat_message_id TEXT PRIMARY KEY, rule_kind TEXT NOT NULL, rule_date TEXT NOT NULL,
    prep_state TEXT NOT NULL, prepared_at INTEGER, visible_at INTEGER,
    notify INTEGER NOT NULL DEFAULT 0, seen_at INTEGER,
    scheduler_authored INTEGER NOT NULL DEFAULT 0,
    UNIQUE(rule_kind, rule_date)
  )`)
  await db.execute(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, doc_id TEXT NOT NULL,
    op TEXT NOT NULL, data TEXT, hlc TEXT NOT NULL, base_hlc TEXT,
    created_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0
  )`)
  await db.execute(`CREATE TABLE sync_doc_hlc (
    collection TEXT NOT NULL, doc_id TEXT NOT NULL, server_hlc TEXT NOT NULL,
    PRIMARY KEY (collection, doc_id)
  )`)
  await db.execute(`CREATE TABLE playlist_items (
    id TEXT PRIMARY KEY, track_id TEXT NOT NULL, added_at INTEGER NOT NULL,
    archived_at INTEGER, collection_id TEXT
  )`)
}

async function outboxRows(db: IDatabase): Promise<OutboxRow[]> {
  return db.query<OutboxRow>("SELECT id, collection, doc_id, op, data FROM outbox ORDER BY id ASC")
}

describe("chat sync journaling", () => {
  let db: IDatabase
  let chatSyncEnabled: boolean
  let repos: ReturnType<typeof withSyncJournaling>
  let proactive: ReturnType<typeof createSqlProactiveStateRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    chatSyncEnabled = true
    const uow = createReentrantUnitOfWork(db)
    proactive = createSqlProactiveStateRepository(db)
    repos = withSyncJournaling(
      {
        // notes / playlist / listening are unused in this suite — empty
        // placeholders (the decorator only spreads / lazily references them).
        notes: {} as never,
        playlistItems: {} as never,
        listeningSessions: {} as never,
        libraryMemberships: {} as never,
        chatSessions: createSqlChatSessionRepository(db),
        chatMessages: createSqlChatMessageRepository(db),
      },
      {
        userDb: db,
        unitOfWork: uow,
        getDeviceId: async () => "dev-A",
        isChatSyncEnabled: () => chatSyncEnabled,
      }
    )
  })

  it("journals a user session (parent) before its first message (child)", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: "Hello" })
    // create() on a session is NOT journaled directly — it enters sync lazily
    // via the first user-initiated message.
    expect(await outboxRows(db)).toHaveLength(0)

    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "hi",
      createdAt: 1000,
    })
    const rows = await outboxRows(db)
    expect(rows.map((r) => [r.collection, r.doc_id, r.op])).toEqual([
      ["chat_sessions", "s1", "upsert"],
      ["chat_messages", "m1", "upsert"],
    ])
    // The message snapshot carries the versioned meta envelope + session_id.
    expect(JSON.parse(rows[1]!.data!)).toMatchObject({
      id: "m1",
      session_id: "s1",
      role: "user",
      content: "hi",
    })
  })

  it("journals the parent session only once across multiple messages", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "q",
      createdAt: 1,
    })
    await repos.chatMessages.create({
      id: "m2" as ChatMessageId,
      sessionId: sid,
      role: "assistant",
      content: "a",
      createdAt: 2,
    })
    const rows = await outboxRows(db)
    expect(rows.filter((r) => r.collection === "chat_sessions")).toHaveLength(1)
    expect(rows.filter((r) => r.collection === "chat_messages")).toHaveLength(2)
  })

  it("skips ALL chat journaling when the Sync chats toggle is off", async () => {
    chatSyncEnabled = false
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: "x" })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "hi",
      createdAt: 1,
    })
    await repos.chatSessions.updateTitle(sid, "renamed")
    await repos.chatSessions.delete(sid)
    expect(await outboxRows(db)).toHaveLength(0)
  })

  it("does NOT journal a proactive message or its proactive-only session", async () => {
    // Proactive content is written straight to SQL by the proactive repo,
    // bypassing chatMessages.create — so it never reaches the decorator.
    const sid = "s-proactive" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: "Holiday" })
    await proactive.create({
      chatMessageId: "pm1" as ChatMessageId,
      sessionId: sid,
      role: "assistant",
      content: "Happy holiday",
      createdAt: 10,
      ruleKind: "holiday" as never,
      ruleDate: "2026-07-05",
      prepState: "ready",
      visibleAt: null,
      notify: false,
    })
    expect(await outboxRows(db)).toHaveLength(0)

    // Deleting a proactive-only session (never journaled) emits no tombstone.
    await repos.chatSessions.delete(sid)
    expect(await outboxRows(db)).toHaveLength(0)
  })

  it("journals updateTitle (LWW) and delete (tombstone) only for a synced session", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "hi",
      createdAt: 1,
    })
    await repos.chatSessions.updateTitle(sid, "Rephrased title")
    await repos.chatSessions.delete(sid)

    const rows = await outboxRows(db)
    const sessionRows = rows.filter((r) => r.collection === "chat_sessions")
    // upsert (via first message ensure) + upsert (title) + delete (tombstone).
    expect(sessionRows.map((r) => r.op)).toEqual(["upsert", "upsert", "delete"])
    const titleUpsert = sessionRows[1]!
    expect(JSON.parse(titleUpsert.data!)).toMatchObject({ id: "s1", title: "Rephrased title" })
    const tombstone = sessionRows[2]!
    expect(tombstone.data).toBeNull()
  })

  it("tombstones a deleted message that had entered sync (chat retry)", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "q",
      createdAt: 1,
    })
    await repos.chatMessages.create({
      id: "m2" as ChatMessageId,
      sessionId: sid,
      role: "assistant",
      content: "truncated",
      createdAt: 2,
    })
    // Retry deletes the failed assistant reply AND the prompt that produced it.
    await repos.chatMessages.delete("m2" as ChatMessageId)
    await repos.chatMessages.delete("m1" as ChatMessageId)

    const messageRows = (await outboxRows(db)).filter((r) => r.collection === "chat_messages")
    expect(messageRows.map((r) => [r.doc_id, r.op])).toEqual([
      ["m1", "upsert"],
      ["m2", "upsert"],
      ["m2", "delete"],
      ["m1", "delete"],
    ])
    expect(messageRows[2]!.data).toBeNull()
    expect(messageRows[3]!.data).toBeNull()
  })

  it("does not tombstone a message that never entered sync", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    chatSyncEnabled = false
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "q",
      createdAt: 1,
    })
    chatSyncEnabled = true
    await repos.chatMessages.delete("m1" as ChatMessageId)
    expect(await outboxRows(db)).toHaveLength(0)
  })

  it("tombstones every synced message of a session on deleteBySession", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "q",
      createdAt: 1,
    })
    await repos.chatMessages.create({
      id: "m2" as ChatMessageId,
      sessionId: sid,
      role: "assistant",
      content: "a",
      createdAt: 2,
    })
    await repos.chatMessages.deleteBySession(sid)

    const tombstones = (await outboxRows(db)).filter(
      (r) => r.collection === "chat_messages" && r.op === "delete"
    )
    expect(tombstones.map((r) => r.doc_id).sort()).toEqual(["m1", "m2"])
    expect(tombstones.every((r) => r.data === null)).toBe(true)
  })

  it("records ONE tombstone for a whole-conversation delete, not one per message", async () => {
    // The order `useChatStore.deleteSession` uses: session first, so its
    // tombstone's server-side cascade covers the messages.
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    for (const id of ["m1", "m2", "m3"]) {
      await repos.chatMessages.create({
        id: id as ChatMessageId,
        sessionId: sid,
        role: "user",
        content: id,
        createdAt: 1,
      })
    }
    await repos.chatSessions.delete(sid)
    await repos.chatMessages.deleteBySession(sid)

    const deletes = (await outboxRows(db)).filter((r) => r.op === "delete")
    expect(deletes.map((r) => [r.collection, r.doc_id])).toEqual([["chat_sessions", "s1"]])
  })

  it("tombstones a message known only through sync_doc_hlc on deleteBySession", async () => {
    // A message pulled from the server (or already pushed and compacted) has
    // no outbox row — the UNION branch of the id lookup is what finds it.
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    chatSyncEnabled = false
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "q",
      createdAt: 1,
    })
    chatSyncEnabled = true
    await db.execute("INSERT INTO sync_doc_hlc (collection, doc_id, server_hlc) VALUES (?, ?, ?)", [
      "chat_messages",
      "m1",
      "1-0-srv",
    ])
    await repos.chatMessages.deleteBySession(sid)

    const rows = await outboxRows(db)
    expect(rows.map((r) => [r.collection, r.doc_id, r.op])).toEqual([
      ["chat_messages", "m1", "delete"],
    ])
  })

  it("emits no message tombstones when the Sync chats toggle is off", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "user",
      content: "q",
      createdAt: 1,
    })
    const before = (await outboxRows(db)).length
    chatSyncEnabled = false
    await repos.chatMessages.delete("m1" as ChatMessageId)
    await repos.chatMessages.deleteBySession(sid)
    expect((await outboxRows(db)).length).toBe(before)
  })

  it("re-journals the snapshot when updateActionStates rewrites meta", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "assistant",
      content: "a",
      createdAt: 1,
    })
    await repos.chatMessages.updateActionStates("m1" as ChatMessageId, { a1: "done" })

    const upserts = (await outboxRows(db)).filter(
      (r) => r.collection === "chat_messages" && r.op === "upsert"
    )
    expect(upserts).toHaveLength(2)
    const meta = JSON.parse(JSON.parse(upserts[1]!.data!).meta)
    expect(meta.data.actionStates).toEqual({ a1: "done" })
  })

  it("re-journals the snapshot when updateFollowups rewrites meta", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "assistant",
      content: "a",
      createdAt: 1,
    })
    await repos.chatMessages.updateFollowups("m1" as ChatMessageId, ["next?"])

    const upserts = (await outboxRows(db)).filter(
      (r) => r.collection === "chat_messages" && r.op === "upsert"
    )
    expect(upserts).toHaveLength(2)
    const meta = JSON.parse(JSON.parse(upserts[1]!.data!).meta)
    expect(meta.data.followups).toEqual(["next?"])
  })

  it("does not re-journal a meta rewrite on a message outside sync", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    chatSyncEnabled = false
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "assistant",
      content: "a",
      createdAt: 1,
    })
    chatSyncEnabled = true
    await repos.chatMessages.updateFollowups("m1" as ChatMessageId, ["next?"])
    await repos.chatMessages.updateActionStates("m1" as ChatMessageId, { a1: "done" })
    expect(await outboxRows(db)).toHaveLength(0)
  })

  it("maps chat repository members explicitly instead of spreading the base", async () => {
    // A bare `{ ...base.chatMessages }` would copy whatever the base object
    // carries — including this probe — and would let a mutating method added
    // to the port be forwarded un-journaled with no type error. The decorated
    // repositories are explicit literals, so the probe must NOT come through.
    const probe = () => "leaked"
    const decorated = withSyncJournaling(
      {
        notes: {} as never,
        playlistItems: {} as never,
        listeningSessions: { __probe: probe } as never,
        libraryMemberships: {} as never,
        chatSessions: { __probe: probe } as never,
        chatMessages: { __probe: probe } as never,
      },
      { userDb: db, unitOfWork: createReentrantUnitOfWork(db), getDeviceId: async () => "dev-A" }
    )
    for (const repo of [
      decorated.chatMessages,
      decorated.chatSessions,
      decorated.listeningSessions,
    ]) {
      expect(Object.keys(repo)).not.toContain("__probe")
    }
    // Every port member is still present and delegating.
    expect(Object.keys(decorated.chatMessages).sort()).toEqual([
      "clearAll",
      "create",
      "delete",
      "deleteBySession",
      "listBySession",
      "updateActionStates",
      "updateFeedback",
      "updateFollowups",
    ])
  })

  it("does not journal message edits (updateFeedback / clearAll are not sync writes)", async () => {
    const sid = "s1" as ChatSessionId
    await repos.chatSessions.create({ id: sid, title: null })
    await repos.chatMessages.create({
      id: "m1" as ChatMessageId,
      sessionId: sid,
      role: "assistant",
      content: "a",
      createdAt: 1,
    })
    const before = (await outboxRows(db)).length
    await repos.chatMessages.updateFeedback("m1" as ChatMessageId, { state: "up" })
    await repos.chatMessages.clearAll()
    await repos.chatSessions.clearAll()
    expect((await outboxRows(db)).length).toBe(before)
  })
})

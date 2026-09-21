import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ChatActionPayload, ChatCiteSnippet } from "@lib/domain/chatMessage.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { createSqlChatMessageRepository } from "../chatMessagesRepository.sql.js"
import { createSqlProactiveStateRepository } from "../proactiveStateRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

const passthroughUow: IUnitOfWork = { run: (fn) => fn() }

const SESSION = "session-1" as ChatSessionId
const UPGRADE: ChatActionPayload = { kind: "upgrade_to_pro", id: "a1", reason: "weekly_digest" }
const CITE: ChatCiteSnippet = { text: "a spoken line" }

interface ProactiveRow {
  prep_state: string
  prepared_at: number | null
  visible_at: number | null
  seen_at: number | null
}

async function setupSchema(db: IDatabase): Promise<void> {
  await db.execute("PRAGMA foreign_keys = ON")
  await db.execute(
    `CREATE TABLE chat_sessions (
       id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  )
  await db.execute(
    `CREATE TABLE chat_messages (
       id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
       role TEXT NOT NULL CHECK(role IN ('user','assistant')),
       content TEXT NOT NULL, created_at INTEGER NOT NULL,
       meta TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}',
       FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE)`
  )
  await db.execute(
    `CREATE TABLE chat_messages_proactive_state (
       chat_message_id TEXT PRIMARY KEY, rule_kind TEXT NOT NULL, rule_date TEXT NOT NULL,
       prep_state TEXT NOT NULL, prepared_at INTEGER, visible_at INTEGER,
       notify INTEGER NOT NULL DEFAULT 0, seen_at INTEGER,
       scheduler_authored INTEGER NOT NULL DEFAULT 0,
       UNIQUE(rule_kind, rule_date),
       FOREIGN KEY (chat_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE)`
  )
}

describe("proactive message lifecycle", () => {
  let db: IDatabase
  let messages: IChatMessageRepository
  let repo: ReturnType<typeof createSqlProactiveStateRepository>

  const sidecar = async (id: string): Promise<ProactiveRow | undefined> =>
    (
      await db.query<ProactiveRow>(
        "SELECT prep_state, prepared_at, visible_at, seen_at FROM chat_messages_proactive_state WHERE chat_message_id = ?",
        [id]
      )
    )[0]

  const message = async (id: string) =>
    (await messages.listBySession(SESSION)).find((m) => m.id === id)

  /** A scheduled message in its freshly created, not-yet-prepared state. */
  async function createPending(id: string, ruleDate: string): Promise<void> {
    await repo.create({
      chatMessageId: id as ChatMessageId,
      sessionId: SESSION,
      role: "assistant",
      content: "",
      createdAt: 1_700_000_000_000,
      visibleAt: 1_700_000_000,
      notify: false,
      ruleKind: "holiday",
      ruleDate,
      prepState: "pending",
    })
  }

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await setupSchema(db)
    await db.execute("INSERT INTO chat_sessions (id, created_at, updated_at) VALUES (?, ?, ?)", [
      SESSION,
      1,
      1,
    ])
    messages = createSqlChatMessageRepository(db, passthroughUow)
    repo = createSqlProactiveStateRepository(db, { chatMessages: messages })
  })

  it("records the moment a message became ready alongside the new state", async () => {
    await createPending("msg-1", "2026-05-18")

    await repo.updatePrepState("msg-1" as ChatMessageId, "ready", 1_700_000_500)

    expect(await sidecar("msg-1")).toMatchObject({
      prep_state: "ready",
      prepared_at: 1_700_000_500,
    })
  })

  it("keeps the earlier preparation stamp when the state moves on without one", async () => {
    await createPending("msg-1", "2026-05-18")
    await repo.updatePrepState("msg-1" as ChatMessageId, "ready", 1_700_000_500)

    await repo.updatePrepState("msg-1" as ChatMessageId, "dismissed")

    expect(await sidecar("msg-1")).toMatchObject({
      prep_state: "dismissed",
      prepared_at: 1_700_000_500,
    })
  })

  it("leaves other scheduled messages alone when one changes state", async () => {
    await createPending("msg-1", "2026-05-18")
    await createPending("msg-2", "2026-05-19")

    await repo.updatePrepState("msg-1" as ChatMessageId, "ready")

    expect(await sidecar("msg-2")).toMatchObject({ prep_state: "pending" })
  })

  it("replaces the body and keeps the cards the message already carried", async () => {
    await messages.create({
      id: "msg-3" as ChatMessageId,
      sessionId: SESSION,
      role: "assistant",
      content: "placeholder",
      createdAt: 1,
      actions: { a1: UPGRADE },
      followups: ["tell me more"],
    })

    await repo.updateContent("msg-3" as ChatMessageId, "the prepared body")

    const stored = await message("msg-3")
    expect(stored?.content).toBe("the prepared body")
    expect(stored?.actions).toEqual({ a1: UPGRADE })
    expect(stored?.followups).toEqual(["tell me more"])
  })

  it("writes the prepared actions over the old ones, keeping the follow-ups", async () => {
    await messages.create({
      id: "msg-4" as ChatMessageId,
      sessionId: SESSION,
      role: "assistant",
      content: "placeholder",
      createdAt: 1,
      actions: { old: { kind: "enable_daily_reminder", id: "old", time: "08:00" } },
      followups: ["tell me more"],
    })

    await repo.updateContent("msg-4" as ChatMessageId, "body", { a1: UPGRADE })

    const stored = await message("msg-4")
    expect(stored?.content).toBe("body")
    expect(stored?.actions).toEqual({ a1: UPGRADE })
    expect(stored?.followups).toEqual(["tell me more"])
  })

  // The rewrite used to rebuild the envelope field by field, and the list had
  // silently fallen behind `attributes`: a message prepared after the user had
  // asked for a reply language came back having forgotten it.
  it("keeps the conversation attributes the message was created with", async () => {
    await messages.create({
      id: "msg-attrs" as ChatMessageId,
      sessionId: SESSION,
      role: "assistant",
      content: "placeholder",
      createdAt: 1,
      actions: { a1: UPGRADE },
      attributes: { reply_language: { value: "en", label: "Language", explicit: true } },
    })

    await repo.updateContent("msg-attrs" as ChatMessageId, "body", { a2: UPGRADE })

    const stored = await message("msg-attrs")
    expect(stored?.attributes).toEqual({
      reply_language: { value: "en", label: "Language", explicit: true },
    })
    expect(stored?.actions).toEqual({ a2: UPGRADE })
  })

  it("writes prepared citations without disturbing the actions", async () => {
    await messages.create({
      id: "msg-5" as ChatMessageId,
      sessionId: SESSION,
      role: "assistant",
      content: "placeholder",
      createdAt: 1,
      actions: { a1: UPGRADE },
    })

    await repo.updateContent("msg-5" as ChatMessageId, "body", undefined, { "t1|0-10": CITE })

    const stored = await message("msg-5")
    expect(stored?.cites).toEqual({ "t1|0-10": CITE })
    expect(stored?.actions).toEqual({ a1: UPGRADE })
  })

  it("adds no message when the body it was asked to rewrite is gone", async () => {
    await repo.updateContent("msg-absent" as ChatMessageId, "body", { a1: UPGRADE })

    expect(await messages.listBySession(SESSION)).toEqual([])
  })

  it("re-anchors a reused message to the new moment and makes it unseen again", async () => {
    await createPending("msg-6", "2026-05-18")
    await repo.updatePrepState("msg-6" as ChatMessageId, "ready")
    await repo.markSeen(SESSION, 1_700_000_900)

    await repo.rearm("msg-6" as ChatMessageId, 1_700_009_000)

    expect(await sidecar("msg-6")).toMatchObject({ visible_at: 1_700_009_000, seen_at: null })
  })
})

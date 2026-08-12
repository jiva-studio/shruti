import { beforeEach, describe, expect, it } from "vitest"
import type {
  ChatChapterBody,
  ChatCiteSnippet,
  ChatCommentaryBody,
  ChatMessage,
  ChatVerseBody,
} from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId, LanguageCode } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlAppRepositories } from "../index.js"
import { createSqlChatMessageRepository } from "../chatMessagesRepository.sql.js"
import { createSqlUnitOfWork } from "../unitOfWork.sql.js"
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
       scheduler_authored INTEGER NOT NULL DEFAULT 0,
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
       (chat_message_id, rule_kind, rule_date, prep_state, scheduler_authored)
     VALUES (?, 'holiday', ?, ?, 1)`,
    [chatMessageId, ruleDate, prepState]
  )
}

/** The other tenant of the sidecar table: a cooldown marker `attach`ed to an
 *  ordinary assistant answer (`scheduler_authored = 0`). */
async function insertInlineHintMarker(
  db: IDatabase,
  chatMessageId: string,
  prepState: string,
  ruleDate: string
): Promise<void> {
  await db.execute(
    `INSERT INTO chat_messages_proactive_state
       (chat_message_id, rule_kind, rule_date, prep_state, scheduler_authored)
     VALUES (?, 'enable_notifications_hint', ?, ?, 0)`,
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
    repo = createSqlChatMessageRepository(db, createSqlUnitOfWork(db))
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

  // #1770: the gate exists to hide a proactive body that is not finished (or
  // no longer wanted). An inline-hint cooldown marker is not a body — its host
  // is a real answer the user asked for, and superseding the marker (the user
  // granted the permission the card offered) must not delete the answer from
  // the conversation.
  it("never gates a message whose sidecar is an inline-hint cooldown marker", async () => {
    await insertMessage(db, "m-answer", SESSION, "here is your answer", 1000)
    await insertInlineHintMarker(db, "m-answer", "superseded", "2026-05-18")
    const rows = await repo.listBySession(SESSION as ChatSessionId)
    expect(rows.map((r) => r.id)).toEqual(["m-answer"])
    expect(rows[0].content).toBe("here is your answer")
  })
})

describe("chatMessagesRepository — card-body meta round-trip", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlChatMessageRepository>
  const SESSION = "session-cards" as ChatSessionId
  const MSG = "m-cards" as ChatMessageId

  // The four card maps keyed exactly as the store writes them — these ride
  // the message's `meta` envelope and must survive create → listBySession so
  // a reopened answer renders cards (not chips). Regression guard for the
  // move off the old global LRU caches.
  const VERSE: ChatVerseBody = {
    addrLabel: "BG 2.13",
    sanskrit: "dehino 'smin yathā dehe",
    transliteration: "dehino 'smin yathā dehe",
    translation: { en: "As the embodied soul…", ru: "Воплощённая душа…" },
    audioUrl: "https://cdn/bg_2_13.mp3",
    mt: true,
  }
  const CITE: ChatCiteSnippet = {
    text: "the soul is eternal",
    mt: true,
    textOriginal: "душа вечна",
  }
  const CHAPTER: ChatChapterBody = {
    regionLabel: "Canto 1",
    chapters: [
      { tokens: "1", title: "Creation" },
      { tokens: "2", title: "Divinity and Divine Service" },
    ],
  }
  const COMMENTARY: ChatCommentaryBody = {
    text: "purport text",
    authorName: "Śrīla Prabhupāda",
    addrLabel: "BG 2.13",
    commentaryKind: "commentary",
  }

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await setupSchema(db)
    repo = createSqlChatMessageRepository(db, createSqlUnitOfWork(db))
  })

  async function createWithCards(): Promise<void> {
    await repo.create({
      id: MSG,
      sessionId: SESSION,
      role: "assistant",
      content: "see [verse:bg/2.13] and [cite:track_x@1000-2000|x] [commentary:3] [chapter:bg/1]",
      createdAt: 1000,
      verses: { "bg|2.13": VERSE },
      cites: { "track_x|1000-2000": CITE },
      chapters: { "bg|1": CHAPTER },
      commentaries: { "3": COMMENTARY },
    })
  }

  it("rehydrates verses/cites/chapters/commentaries through create → listBySession", async () => {
    await createWithCards()
    const [row] = await repo.listBySession(SESSION)
    expect(row.verses).toEqual({ "bg|2.13": VERSE })
    expect(row.cites).toEqual({ "track_x|1000-2000": CITE })
    expect(row.chapters).toEqual({ "bg|1": CHAPTER })
    expect(row.commentaries).toEqual({ "3": COMMENTARY })
  })

  it("returns empty card maps when none were persisted", async () => {
    await repo.create({
      id: MSG,
      sessionId: SESSION,
      role: "assistant",
      content: "plain answer",
      createdAt: 1000,
    })
    const [row] = await repo.listBySession(SESSION)
    expect(row.verses).toEqual({})
    expect(row.cites).toEqual({})
    expect(row.chapters).toEqual({})
    expect(row.commentaries).toEqual({})
  })

  it("updateActionStates preserves the card bodies", async () => {
    await createWithCards()
    await repo.updateActionStates(MSG, { a1: "done" })
    const [row] = await repo.listBySession(SESSION)
    expect(row.actionStates).toEqual({ a1: "done" })
    expect(row.verses).toEqual({ "bg|2.13": VERSE })
    expect(row.commentaries).toEqual({ "3": COMMENTARY })
  })

  it("updateFollowups preserves the card bodies", async () => {
    await createWithCards()
    await repo.updateFollowups(MSG, ["next?"])
    const [row] = await repo.listBySession(SESSION)
    expect(row.followups).toEqual(["next?"])
    expect(row.cites).toEqual({ "track_x|1000-2000": CITE })
    expect(row.chapters).toEqual({ "bg|1": CHAPTER })
  })

  it("updateFeedback preserves the card bodies", async () => {
    await createWithCards()
    await repo.updateFeedback(MSG, { state: "down", category: "bad_citations" })
    const [row] = await repo.listBySession(SESSION)
    expect(row.feedbackState).toBe("down")
    expect(row.verses).toEqual({ "bg|2.13": VERSE })
    expect(row.cites).toEqual({ "track_x|1000-2000": CITE })
  })
})

describe("chatMessagesRepository — settled conversation attributes", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlChatMessageRepository>
  const SESSION = "session-lang" as ChatSessionId
  const MSG = "m-lang" as ChatMessageId
  const RU = { reply_language: { value: "ru", label: "Русский", explicit: true } } as const

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await setupSchema(db)
    repo = createSqlChatMessageRepository(db, createSqlUnitOfWork(db))
  })

  it("survives create → listBySession so the switch outlives a cold start", async () => {
    // Without this the language a user asked for is lost on app restart and the
    // reply silently reverts to the interface locale. Also what the client folds
    // its request-level aggregate out of.
    await repo.create({
      id: MSG,
      sessionId: SESSION,
      role: "assistant",
      content: "Хорошо, отвечаю по-русски.",
      createdAt: 1000,
      attributes: RU,
    })
    const [row] = await repo.listBySession(SESSION)
    expect(row.attributes).toEqual(RU)
  })

  it("is absent on a message that settled none", async () => {
    await repo.create({
      id: MSG,
      sessionId: SESSION,
      role: "assistant",
      content: "plain answer",
      createdAt: 1000,
    })
    const [row] = await repo.listBySession(SESSION)
    expect(row.attributes).toBeUndefined()
  })

  it("keeps an attribute this build knows nothing about", async () => {
    // Forward compatibility: an app that predates an attribute must still store
    // and replay it, or a newer server's setting dies on an older client.
    await repo.create({
      id: MSG,
      sessionId: SESSION,
      role: "assistant",
      content: "Ответ.",
      createdAt: 1000,
      attributes: { future_thing: { value: "42", label: "", explicit: false } },
    })
    const [row] = await repo.listBySession(SESSION)
    expect(row.attributes).toEqual({
      future_thing: { value: "42", label: "", explicit: false },
    })
  })

  it("survives the read-modify-write meta updates", async () => {
    // Each of these rewrites the whole envelope; dropping the field in one of
    // them would silently un-switch the language mid-conversation.
    await repo.create({
      id: MSG,
      sessionId: SESSION,
      role: "assistant",
      content: "Ответ.",
      createdAt: 1000,
      attributes: RU,
    })
    await repo.updateActionStates(MSG, { a1: "done" })
    await repo.updateFollowups(MSG, ["ещё?"])
    await repo.updateFeedback(MSG, { state: "up" })
    const [row] = await repo.listBySession(SESSION)
    expect(row.attributes).toEqual(RU)
  })
})

/**
 * Wraps a test db so `transaction()` serialises callers through a promise
 * chain, as the real sql.js / Capacitor adapters' `txQueue` does. Without it
 * a second transaction opened while one is in flight would nest, and SQLite
 * rejects that — the queue is what makes an unrelated concurrent write simply
 * wait its turn.
 */
function withTxQueue(db: IDatabase): IDatabase {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    ...db,
    transaction(fn: () => Promise<void>): Promise<void> {
      const next = queue.then(() => db.transaction(fn))
      queue = next.then(
        () => undefined,
        () => undefined
      )
      return next
    },
  }
}

/** Fake db recording the statement kinds it sees, so a test can pin how many
 *  transactions a single repository call opens. */
function makeSerialisingDb() {
  const events: string[] = []
  const db: IDatabase = {
    async query<T>(): Promise<T[]> {
      events.push("SELECT")
      return [{ meta: null }] as unknown as T[]
    },
    async execute(sql: string): Promise<void> {
      events.push(sql.split(" ")[0])
    },
    async transaction(fn: () => Promise<void>): Promise<void> {
      events.push("BEGIN")
      try {
        await fn()
        events.push("COMMIT")
      } catch (e) {
        events.push("ROLLBACK")
        throw e
      }
    },
    async save(): Promise<void> {},
    async close(): Promise<void> {},
  }
  return { db, events }
}

describe("chatMessagesRepository — unit-of-work participation", () => {
  let db: IDatabase
  let unitOfWork: IUnitOfWork
  let repo: IChatMessageRepository
  const SESSION = "session-uow" as ChatSessionId
  const MSG = "m-uow" as ChatMessageId

  // The three read-modify-writes of the `meta` envelope. Each used to open a
  // transaction of its own with `runInTransaction`, bypassing the injected
  // unit of work entirely.
  const CASES = [
    {
      name: "updateFollowups",
      write: (r: IChatMessageRepository) => r.updateFollowups(MSG, ["next?"]),
      read: (m: ChatMessage): unknown => m.followups,
      written: ["next?"],
    },
    {
      name: "updateActionStates",
      write: (r: IChatMessageRepository) => r.updateActionStates(MSG, { a1: "done" }),
      read: (m: ChatMessage): unknown => m.actionStates,
      written: { a1: "done" },
    },
    {
      name: "updateFeedback",
      write: (r: IChatMessageRepository) => r.updateFeedback(MSG, { state: "down" as const }),
      read: (m: ChatMessage): unknown => m.feedbackState,
      written: "down",
    },
  ]

  beforeEach(async () => {
    const raw = await createInMemoryTestDatabase()
    await setupSchema(raw)
    db = withTxQueue(raw)
    // Built through the real composition root, not by hand: which unit of work
    // each repository gets is exactly what these tests are pinning.
    const repos = createSqlAppRepositories({
      contentDb: db,
      userDb: db,
      getActiveLanguage: () => "en" as LanguageCode,
    })
    unitOfWork = repos.unitOfWork
    repo = repos.chatMessages
    await repo.create({
      id: MSG,
      sessionId: SESSION,
      role: "assistant",
      content: "answer",
      createdAt: 1000,
    })
  })

  it.each(CASES)("$name commits when called standalone", async ({ write, read, written }) => {
    await write(repo)
    const [row] = await repo.listBySession(SESSION)
    expect(read(row)).toEqual(written)
  })

  it.each(CASES)(
    "$name survives an unrelated transaction that rolls back",
    async ({ write, read, written }) => {
      // `createReentrantUnitOfWork`'s depth counter is a plain closure with no
      // execution-context binding, raised for the whole of any top-level run.
      // Give the chat-message repository that same instance and this write is
      // misread as nested, spliced into the pull's transaction and discarded
      // with it — the user's 👍 resolves fine and the row never changes.
      let open: (() => void) | undefined
      let release: (() => void) | undefined
      const opened = new Promise<void>((resolve) => (open = resolve))
      const gate = new Promise<void>((resolve) => (release = resolve))

      // A sync pull holds one transaction across a whole page of `applyRemote`
      // awaits (`backfillLocal` holds one across the entire first-sign-in walk),
      // then fails.
      const pull = unitOfWork.run(async () => {
        open!()
        await gate
        throw new Error("pull failed")
      })
      await opened

      // The user taps mid-pull: `submitChatFeedback` awaits its network POST
      // first, so the local write lands squarely inside that window.
      const local = write(repo)
      release!()
      await expect(pull).rejects.toThrow("pull failed")
      await local

      const [row] = await repo.listBySession(SESSION)
      expect(read(row)).toEqual(written)
    }
  )

  it("opens exactly one transaction per standalone meta write", async () => {
    const { db: recording, events } = makeSerialisingDb()
    const standalone = createSqlChatMessageRepository(recording, createSqlUnitOfWork(recording))
    await standalone.updateFollowups(MSG, ["next?"])
    expect(events).toEqual(["BEGIN", "SELECT", "UPDATE", "COMMIT"])
  })
})

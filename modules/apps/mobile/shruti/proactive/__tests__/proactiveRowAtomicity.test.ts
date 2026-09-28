import { beforeEach, describe, expect, it, vi } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { IsoDate, LanguageCode, TrackId } from "@lib/domain/core.js"
import type { IProactiveStateRepository } from "@lib/domain/ports/proactiveStateRepository.js"
import type { Track } from "@lib/domain/track.js"
import { createInMemoryTestDatabase } from "@infra/repositories/sql/__tests__/testDb.js"
import { createReentrantUnitOfWork } from "@infra/repositories/sql/reentrantUnitOfWork.sql.js"
import { createSqlUnitOfWork } from "@infra/repositories/sql/unitOfWork.sql.js"
import { createSqlChatSessionRepository } from "@infra/repositories/sql/chatSessionsRepository.sql.js"
import { createSqlChatMessageRepository } from "@infra/repositories/sql/chatMessagesRepository.sql.js"
import { createSqlProactiveStateRepository } from "@infra/repositories/sql/proactiveStateRepository.sql.js"
import { withSyncJournaling } from "@infra/repositories/sql/syncJournalDecorator.js"
import { detectForRule } from "@shruti/composables/proactiveDetect.js"
import type { ProactiveContext, ResolvedProactiveRule } from "../types.js"
import { resolveRules } from "../registry.js"
import "../rules/inactivity.js"
import "../rules/unfinishedLecture.js"

/**
 * A proactive row and the chat session it lands in are one unit: over the real
 * repositories, a failed or deduplicated insert leaves no session behind and
 * writes nothing to the sync journal.
 */

const NOW = new Date(2026, 5, 1, 12, 0, 0, 0).getTime()
const HOUR_MS = 3_600_000

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
    created_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT
  )`)
  await db.execute(`CREATE TABLE sync_doc_hlc (
    collection TEXT NOT NULL, doc_id TEXT NOT NULL, server_hlc TEXT NOT NULL,
    PRIMARY KEY (collection, doc_id)
  )`)
}

function unfinishedTrack(): Track {
  return {
    id: "track-1" as TrackId,
    authorId: null,
    locationId: null,
    date: "2026-01-01" as IsoDate,
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [{ language: "en", title: "Lecture", audio: { duration: HOUR_MS } }],
  } as unknown as Track
}

function rule(id: string): ResolvedProactiveRule {
  const found = resolveRules().find((r) => r.config.id === id)
  if (!found) throw new Error(`${id} is not registered`)
  return found
}

let db: IDatabase
let proactiveState: IProactiveStateRepository
let ctx: ProactiveContext

async function count(table: string): Promise<number> {
  const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return Number(rows[0]?.n ?? 0)
}

/** The row store as the rules see it, with `create` failing after its inserts. */
function failingCreate(): IProactiveStateRepository {
  return {
    ...proactiveState,
    create: async (input, tx) => {
      await proactiveState.create(input, tx)
      throw new Error("disk I/O error")
    },
  }
}

/** The row store with a dedup lookup that misses the row a concurrent tick wrote. */
function racingLookup(): IProactiveStateRepository {
  return { ...proactiveState, findByRuleAndDate: async () => null }
}

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  db = await createInMemoryTestDatabase()
  await applySchema(db)
  const unitOfWork = createReentrantUnitOfWork(db)
  const repos = withSyncJournaling(
    {
      notes: {} as never,
      playlistItems: {} as never,
      listeningSessions: {} as never,
      libraryMemberships: {} as never,
      chatSessions: createSqlChatSessionRepository(db),
      chatMessages: createSqlChatMessageRepository(db, createSqlUnitOfWork(db)),
    },
    {
      userDb: db,
      unitOfWork,
      getDeviceId: async () => "dev-A",
      isChatSyncEnabled: () => true,
    }
  )
  proactiveState = createSqlProactiveStateRepository(db, {
    chatMessages: repos.chatMessages,
    unitOfWork,
  })
  ctx = {
    nowMs: NOW,
    locale: "en",
    libraryLanguages: ["en" as LanguageCode],
    t: (key: string) => key,
    repos: {
      unitOfWork,
      chatSessions: repos.chatSessions,
      proactiveState,
      listeningSessions: {
        listRecentTracksWithProgress: async () => [
          { trackId: "track-1" as TrackId, positionSec: 1800 },
        ],
      },
      tracks: {
        getByIds: async () => new Map([["track-1", unfinishedTrack()]]),
      },
    },
  } as unknown as ProactiveContext
})

function withRowStore(store: IProactiveStateRepository): ProactiveContext {
  return { ...ctx, repos: { ...ctx.repos, proactiveState: store } }
}

describe("proactive row + session atomicity", () => {
  it("inactivity: a failed row insert leaves no session behind", async () => {
    await expect(
      rule("inactivity").handler.onAppPause!(withRowStore(failingCreate()))
    ).rejects.toThrow(/disk I\/O/)

    expect(await count("chat_sessions")).toBe(0)
    expect(await count("chat_messages")).toBe(0)
  })

  it("inactivity: losing the dedup race leaves one session and no journal entry", async () => {
    await rule("inactivity").handler.onAppPause!(ctx)
    await rule("inactivity").handler.onAppPause!(withRowStore(racingLookup()))

    expect(await count("chat_sessions")).toBe(1)
    expect(await count("chat_messages_proactive_state")).toBe(1)
    expect(await count("outbox")).toBe(0)
  })

  it("unfinished lecture: a failed row insert leaves no session behind", async () => {
    await expect(
      rule("unfinished_lecture").handler.onAppPause!(withRowStore(failingCreate()))
    ).rejects.toThrow(/disk I\/O/)

    expect(await count("chat_sessions")).toBe(0)
    expect(await count("chat_messages")).toBe(0)
  })

  it("unfinished lecture: losing the dedup race leaves one session", async () => {
    await rule("unfinished_lecture").handler.onAppPause!(ctx)
    await rule("unfinished_lecture").handler.onAppPause!(withRowStore(racingLookup()))

    expect(await count("chat_sessions")).toBe(1)
    expect(await count("outbox")).toBe(0)
  })

  it("detector path: a failed row insert leaves no session behind", async () => {
    const detected: ResolvedProactiveRule = {
      ...rule("unfinished_lecture"),
      handler: {
        ...rule("unfinished_lecture").handler,
        detect: async () => [
          {
            ruleDate: "2026-06-01",
            visibleAt: null,
            notify: false,
            templateContext: {},
          },
        ],
      },
    }
    const store = failingCreate()

    await detectForRule(detected, withRowStore(store), store, ctx.repos.chatSessions)

    expect(await count("chat_sessions")).toBe(0)
    expect(await count("chat_messages")).toBe(0)
  })

  it("detector path: a new detection lands its session and row together", async () => {
    const detected: ResolvedProactiveRule = {
      ...rule("unfinished_lecture"),
      handler: {
        ...rule("unfinished_lecture").handler,
        detect: async () => [
          {
            ruleDate: "2026-06-01",
            visibleAt: null,
            notify: false,
            templateContext: {},
          },
        ],
      },
    }

    await detectForRule(detected, ctx, proactiveState, ctx.repos.chatSessions)

    expect(await count("chat_sessions")).toBe(1)
    expect(await count("chat_messages_proactive_state")).toBe(1)
  })
})

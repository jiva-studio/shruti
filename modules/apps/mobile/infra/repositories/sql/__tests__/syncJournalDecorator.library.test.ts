import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { ILibraryMembershipRepository } from "@lib/domain/ports/libraryMembershipRepository.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import { withSyncJournaling } from "../syncJournalDecorator.js"
import { createInMemoryTestDatabase } from "./testDb.js"

interface OutboxRow {
  collection: string
  doc_id: string
  op: string
  data: string | null
}

const passthroughUow: IUnitOfWork = { run: (fn) => fn() }

async function applySchema(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE outbox (
       id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, doc_id TEXT NOT NULL,
       op TEXT NOT NULL, data TEXT, hlc TEXT NOT NULL, base_hlc TEXT,
       created_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, owner_id TEXT)`
  )
  await db.execute(
    `CREATE TABLE sync_doc_hlc (
       collection TEXT NOT NULL, doc_id TEXT NOT NULL, server_hlc TEXT NOT NULL,
       PRIMARY KEY (collection, doc_id))`
  )
  await db.execute(
    `CREATE TABLE listening_sessions (
       id TEXT PRIMARY KEY, item_id TEXT NOT NULL, started_at INTEGER NOT NULL,
       ended_at INTEGER NOT NULL, from_position INTEGER NOT NULL, to_position INTEGER NOT NULL)`
  )
  await db.execute(
    `CREATE TABLE playlist_items (
       id TEXT PRIMARY KEY, track_id TEXT NOT NULL, added_at INTEGER NOT NULL,
       archived_at INTEGER, collection_id TEXT)`
  )
  await db.execute(
    `CREATE TABLE library_memberships (
       id TEXT PRIMARY KEY, archived_at INTEGER, updated_at INTEGER)`
  )
}

function stubNotes(): INoteRepository {
  return {
    getById: async () => null,
    listByTrack: async () => [],
    listRecent: async () => [],
    create: async (input) => ({
      id: "note_1",
      trackId: input.trackId,
      text: input.text,
      timeStart: input.timeStart,
      timeEnd: input.timeEnd,
      createdAt: 1000,
      meta: null,
    }),
    update: async (input) => ({
      id: input.id,
      trackId: "t1",
      text: input.text ?? "",
      timeStart: 0,
      timeEnd: 5,
      createdAt: 1000,
      meta: null,
    }),
    delete: async () => {},
    clearAll: async () => {},
  }
}

function stubPlaylist(): IPlaylistItemRepository {
  return {
    getById: async () => null,
    listActive: async () => [],
    listArchived: async () => [],
    add: async (trackId) => ({
      id: `pl_${trackId}`,
      trackId,
      addedAt: 1,
      archivedAt: null,
      collectionId: null,
    }),
    archive: async () => {},
    remove: async () => {},
    clearAll: async () => {},
  }
}

/** Closes the session row in the database, the way the SQL repository does. */
function stubSessions(db: IDatabase): IListeningSessionRepository {
  const close = async (id: string, toPosition: number, endedAt: number): Promise<void> => {
    await db.execute("UPDATE listening_sessions SET to_position = ?, ended_at = ? WHERE id = ?", [
      toPosition,
      endedAt,
      id,
    ])
  }
  return {
    start: async () => "ls_1",
    forceStart: async () => "ls_1",
    forceStartOnce: async () => "ls_1",
    tick: async () => {},
    finish: async (id: string, args: { position: number }) => close(id, args.position, 900),
    finishAt: async (id: string, args: { position: number; endedAtSec: number }) =>
      close(id, args.position, args.endedAtSec),
    getLastSessionForItem: async () => null,
    getResumePositionForItem: async () => 42,
    getProgressForItems: async () => new Map(),
    getCompletedAtForItems: async () => new Map(),
    listEverCompletedItems: async () => [],
    getDailyTotals: async () => [],
    getDailyTotalsByDayOffset: async () => [],
    hasAny: async () => false,
    getTotalListenedSeconds: async () => 0,
    listRecentTracksWithProgress: async () => [],
    getTracksListenedInRange: async () => [],
    clearAll: async () => {},
  } as unknown as IListeningSessionRepository
}

/** Writes the membership row, the way the SQL repository does. */
function stubMemberships(db: IDatabase): ILibraryMembershipRepository {
  const write = async (id: string, archivedAt: number | null): Promise<void> => {
    await db.execute(
      `INSERT INTO library_memberships (id, archived_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET archived_at = excluded.archived_at,
                                       updated_at = excluded.updated_at`,
      [id, archivedAt, 777]
    )
  }
  return {
    listArchivedIds: async () => new Set(["lib_archived"]),
    getById: async () => null,
    setArchived: (id: string) => write(id, 555),
    setActive: (id: string) => write(id, null),
    clearAll: async () => {},
  } as unknown as ILibraryMembershipRepository
}

function stubChatSessions(): IChatSessionRepository {
  return {
    list: async () => [],
    getById: async () => null,
    create: async (input) => ({
      id: input.id,
      title: input.title,
      createdAt: 0,
      updatedAt: 0,
      trackId: input.trackId ?? null,
    }),
    updateTitle: async () => {},
    touch: async () => {},
    delete: async () => {},
    clearAll: async () => {},
    findLatestByTrack: async () => null,
  }
}

function stubChatMessages(): IChatMessageRepository {
  return {
    listBySession: async () => [],
    create: async (input) => ({
      id: input.id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt,
    }),
    updateActionStates: async () => {},
    delete: async () => {},
    updateFollowups: async () => {},
    deleteBySession: async () => {},
    clearAll: async () => {},
    updateFeedback: async () => {},
  }
}

describe("withSyncJournaling — sessions and library memberships", () => {
  let db: IDatabase
  let repos: ReturnType<typeof withSyncJournaling>

  const outbox = (): Promise<OutboxRow[]> =>
    db.query<OutboxRow>("SELECT collection, doc_id, op, data FROM outbox ORDER BY id")

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    await db.execute(`INSERT INTO playlist_items (id, track_id, added_at) VALUES ('pl_1', 't1', 1)`)
    await db.execute(
      `INSERT INTO listening_sessions (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_1', 'pl_1', 100, 0, 30, 30)`
    )
    repos = withSyncJournaling(
      {
        notes: stubNotes(),
        playlistItems: stubPlaylist(),
        listeningSessions: stubSessions(db),
        chatSessions: stubChatSessions(),
        chatMessages: stubChatMessages(),
        libraryMemberships: stubMemberships(db),
      },
      {
        userDb: db,
        unitOfWork: passthroughUow,
        getDeviceId: async () => "dev-test",
        getOwnerId: () => "user-1",
      }
    )
  })

  it("journals a session closed at a given time, keyed on the session id", async () => {
    await repos.listeningSessions.finishAt("ls_1", { position: 240, endedAtSec: 999 })

    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      collection: "listening_sessions",
      doc_id: "ls_1",
      op: "upsert",
    })
    expect(JSON.parse(rows[0].data!)).toEqual({
      id: "ls_1",
      item_id: "pl_1",
      track_id: "t1",
      started_at: 100,
      ended_at: 999,
      from_position: 30,
      to_position: 240,
    })
  })

  it("journals the session as it stands after finish, not as it was", async () => {
    await repos.listeningSessions.finish("ls_1", { position: 180 })

    const rows = await outbox()
    expect(JSON.parse(rows[0].data!)).toMatchObject({ to_position: 180, ended_at: 900 })
  })

  it("journals nothing for a session whose row is gone", async () => {
    await repos.listeningSessions.finish("ls_missing", { position: 10 })

    expect(await outbox()).toEqual([])
  })

  it("carries no track when the playlist item behind the session is gone", async () => {
    await db.execute("DELETE FROM playlist_items WHERE id = 'pl_1'")

    await repos.listeningSessions.finish("ls_1", { position: 10 })

    expect(JSON.parse((await outbox())[0].data!)).toMatchObject({ track_id: null })
  })

  it("does not journal an in-flight session", async () => {
    await repos.listeningSessions.start({ itemId: "pl_1", position: 0 })
    await repos.listeningSessions.tick("ls_1", { position: 10 })

    expect(await outbox()).toEqual([])
  })

  it("journals a note update with the text it now holds", async () => {
    await repos.notes.update({ id: "note_1", text: "revised" })

    const rows = await outbox()
    expect(rows[0]).toMatchObject({ collection: "notes", doc_id: "note_1", op: "upsert" })
    expect(JSON.parse(rows[0].data!)).toMatchObject({ id: "note_1", text: "revised" })
  })

  it("journals a removal from the library as an upsert carrying the removal time", async () => {
    await repos.libraryMemberships.setArchived("lib_1")

    const rows = await outbox()
    expect(rows[0]).toMatchObject({
      collection: "library_memberships",
      doc_id: "lib_1",
      op: "upsert",
    })
    expect(JSON.parse(rows[0].data!)).toEqual({ id: "lib_1", archived_at: 555, updated_at: 777 })
  })

  it("journals a re-add as an upsert with no removal time, never a tombstone", async () => {
    await repos.libraryMemberships.setArchived("lib_1")
    await repos.libraryMemberships.setActive("lib_1")

    const rows = await outbox()
    expect(rows.map((r) => r.op)).toEqual(["upsert", "upsert"])
    expect(JSON.parse(rows[1].data!)).toMatchObject({ archived_at: null })
  })

  it("delegates the reads it does not intercept", async () => {
    expect(await repos.libraryMemberships.listArchivedIds()).toEqual(new Set(["lib_archived"]))
    expect(await repos.listeningSessions.getResumePositionForItem("pl_1")).toBe(42)
    expect(await outbox()).toEqual([])
  })
})

import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { ILibraryMembershipRepository } from "@lib/domain/ports/libraryMembershipRepository.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { Note } from "@lib/domain/note.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import { withSyncJournaling } from "../syncJournalDecorator.js"
import { createInMemoryTestDatabase } from "./testDb.js"

const passthroughUow: IUnitOfWork = { run: (fn) => fn() }

const NOTE: Note = {
  id: "note_1",
  trackId: "t1",
  text: "stored",
  timeStart: 0,
  timeEnd: 10,
  createdAt: 1000,
  meta: null,
}

const ITEM: PlaylistItem = {
  id: "pl_1",
  trackId: "t1",
  addedAt: 1,
  archivedAt: null,
  collectionId: null,
}

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
    getById: async (id) => (id === NOTE.id ? NOTE : null),
    listByTrack: async (trackId) => (trackId === NOTE.trackId ? [NOTE] : []),
    listRecent: async (limit) => [NOTE].slice(0, limit ?? 1),
    create: async (input) => ({ ...NOTE, trackId: input.trackId, text: input.text }),
    update: async (input) => ({ ...NOTE, id: input.id, text: input.text ?? NOTE.text }),
    delete: async () => {},
    clearAll: async () => {},
  }
}

/** Playlist repository holding nothing, so the decorator's "the row is gone"
 *  branches are what runs. */
function stubEmptyPlaylist(): IPlaylistItemRepository {
  return {
    getById: async () => null,
    listActive: async () => [ITEM],
    listArchived: async () => [{ ...ITEM, id: "pl_2", archivedAt: 5 }],
    add: async (trackId, collectionId) => ({
      ...ITEM,
      id: `pl_${trackId}`,
      trackId,
      collectionId: collectionId ?? null,
    }),
    archive: async () => {},
    remove: async () => {},
    clearAll: async () => {},
  }
}

function stubSessions(): IListeningSessionRepository {
  return {
    start: async () => "ls_started",
    forceStart: async () => "ls_forced",
    forceStartOnce: async () => ({ id: "ls_once", created: true }),
    tick: async () => {},
    finish: async () => {},
    finishAt: async () => {},
    getLastSessionForItem: async (itemId) => ({
      id: "ls_1",
      itemId,
      startedAt: 100,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 60,
    }),
    getResumePositionForItem: async () => 42,
    getProgressForItems: async () => new Map([["pl_1", { position: 60, updatedAtSec: 200 }]]),
    getCompletedAtForItems: async () => new Map([["pl_1", 200]]),
    listEverCompletedItems: async () => new Set(["pl_1"]),
    getDailyTotals: async () => [{ date: "2026-01-01", listenedSeconds: 300 }],
    getDailyTotalsByDayOffset: async () => [{ dayOffset: 0, listenedSeconds: 300 }],
    hasAny: async () => true,
    getTotalListenedSeconds: async () => 900,
    listRecentTracksWithProgress: async () => [
      { trackId: "t1", endedAtMs: 200_000, positionSec: 60 },
    ],
    getTracksListenedInRange: async () => [{ trackId: "t1", listenedSeconds: 60 }],
    clearAll: async () => {},
  }
}

/** Membership repository that accepts the write but persists no row, so the
 *  decorator has nothing to snapshot. */
function stubUnwrittenMemberships(): ILibraryMembershipRepository {
  return {
    listArchivedIds: async () => new Set(["lib_archived"]),
    getById: async (id) => ({ id, archivedAt: 555 }),
    setArchived: async () => {},
    setActive: async () => {},
    clearAll: async () => {},
  }
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

describe("withSyncJournaling — delegated reads and rows the journal cannot see", () => {
  let db: IDatabase
  let repos: ReturnType<typeof withSyncJournaling>

  const outboxSize = async (): Promise<number> =>
    (await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM outbox"))[0]!.n

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    repos = withSyncJournaling(
      {
        notes: stubNotes(),
        playlistItems: stubEmptyPlaylist(),
        listeningSessions: stubSessions(),
        chatSessions: stubChatSessions(),
        chatMessages: stubChatMessages(),
        libraryMemberships: stubUnwrittenMemberships(),
      },
      {
        userDb: db,
        unitOfWork: passthroughUow,
        getDeviceId: async () => "dev-test",
        getOwnerId: () => "user-1",
      }
    )
  })

  it("answers note reads with what the repository holds", async () => {
    expect(await repos.notes.getById("note_1")).toEqual(NOTE)
    expect(await repos.notes.getById("note_absent")).toBeNull()
    expect(await repos.notes.listByTrack("t1")).toEqual([NOTE])
    expect(await repos.notes.listRecent(1)).toEqual([NOTE])
    expect(await outboxSize()).toBe(0)
  })

  it("answers playlist reads with what the repository holds", async () => {
    expect(await repos.playlistItems.getById("pl_1")).toBeNull()
    expect(await repos.playlistItems.listActive()).toEqual([ITEM])
    expect(await repos.playlistItems.listArchived()).toEqual([
      { ...ITEM, id: "pl_2", archivedAt: 5 },
    ])
    expect(await outboxSize()).toBe(0)
  })

  it("returns the membership the repository holds", async () => {
    expect(await repos.libraryMemberships.getById("lib_1")).toEqual({
      id: "lib_1",
      archivedAt: 555,
    })
    expect(await repos.libraryMemberships.listArchivedIds()).toEqual(new Set(["lib_archived"]))
  })

  it("opens a session without journaling it, whichever way it was opened", async () => {
    expect(await repos.listeningSessions.start({ itemId: "pl_1", position: 0 })).toBe("ls_started")
    expect(await repos.listeningSessions.forceStart({ itemId: "pl_1", position: 30 })).toBe(
      "ls_forced"
    )
    expect(
      await repos.listeningSessions.forceStartOnce({
        itemId: "pl_1",
        position: 30,
        endPosition: 90,
        sourceKey: "queue-1",
        runWindow: { fromSec: 0, toSec: 1000 },
      })
    ).toEqual({ id: "ls_once", created: true })
    await repos.listeningSessions.tick("ls_started", { position: 45 })

    expect(await outboxSize()).toBe(0)
  })

  it("answers listening statistics with the repository's own numbers", async () => {
    expect(await repos.listeningSessions.getLastSessionForItem("pl_1")).toMatchObject({
      id: "ls_1",
      itemId: "pl_1",
      toPosition: 60,
    })
    expect(await repos.listeningSessions.getResumePositionForItem("pl_1")).toBe(42)
    expect(await repos.listeningSessions.getProgressForItems(["pl_1"])).toEqual(
      new Map([["pl_1", { position: 60, updatedAtSec: 200 }]])
    )
    expect(await repos.listeningSessions.getCompletedAtForItems(["pl_1"], new Map())).toEqual(
      new Map([["pl_1", 200]])
    )
    expect(await repos.listeningSessions.listEverCompletedItems(["pl_1"], new Map())).toEqual(
      new Set(["pl_1"])
    )
    expect(await repos.listeningSessions.hasAny()).toBe(true)
    expect(await repos.listeningSessions.getTotalListenedSeconds()).toBe(900)
    expect(await outboxSize()).toBe(0)
  })

  it("answers the digest queries with the repository's own totals", async () => {
    expect(await repos.listeningSessions.getDailyTotals(0, 1000)).toEqual([
      { date: "2026-01-01", listenedSeconds: 300 },
    ])
    expect(await repos.listeningSessions.getDailyTotalsByDayOffset(0, 1000)).toEqual([
      { dayOffset: 0, listenedSeconds: 300 },
    ])
    expect(await repos.listeningSessions.listRecentTracksWithProgress(10)).toEqual([
      { trackId: "t1", endedAtMs: 200_000, positionSec: 60 },
    ])
    expect(await repos.listeningSessions.getTracksListenedInRange(0, 1000)).toEqual([
      { trackId: "t1", listenedSeconds: 60 },
    ])
  })

  it("journals nothing when a wipe clears the synced collections", async () => {
    await repos.notes.clearAll()
    await repos.playlistItems.clearAll()
    await repos.listeningSessions.clearAll()
    await repos.libraryMemberships.clearAll()

    expect(await outboxSize()).toBe(0)
  })

  it("journals nothing for archiving a playlist item that no longer exists", async () => {
    await repos.playlistItems.archive("pl_gone")

    expect(await outboxSize()).toBe(0)
  })

  it("journals nothing for removing a playlist item that no longer exists", async () => {
    await repos.playlistItems.remove("pl_gone")

    expect(await outboxSize()).toBe(0)
  })

  it("journals nothing when the membership write left no row to snapshot", async () => {
    await repos.libraryMemberships.setArchived("lib_1")
    await repos.libraryMemberships.setActive("lib_1")

    expect(await outboxSize()).toBe(0)
  })
})

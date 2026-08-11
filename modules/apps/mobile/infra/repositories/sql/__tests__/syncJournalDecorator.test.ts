import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase, QueryParams } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { Note } from "@lib/domain/note.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { ILibraryMembershipRepository } from "@lib/domain/ports/libraryMembershipRepository.js"
import type { ListeningSessionRow } from "@lib/persistence/user"
import { compareHlcString, hlcToString } from "@lib/domain"
import { withSyncJournaling } from "../syncJournalDecorator.js"

interface OutboxRow {
  id: number
  collection: string
  doc_id: string
  op: string
  data: string | null
  hlc: string
  owner_id: string | null
}

/** Minimal in-memory IDatabase covering exactly what the decorator queries:
 *  the HLC seed (outbox tail ∪ recorded server stamps), a
 *  listening-session-by-id read, and the outbox INSERT. */
function makeFakeDb(
  sessions: Map<string, ListeningSessionRow>,
  playlist: Map<string, { id: string; track_id: string }> = new Map(),
  /** `sync_doc_hlc`: the server HLC of every doc this device has pulled,
   *  keyed `${collection} ${docId}`. */
  docHlc: Map<string, string> = new Map()
) {
  const outbox: OutboxRow[] = []
  let seq = 0
  const db: IDatabase = {
    async query<T>(sql: string, params?: QueryParams): Promise<T[]> {
      // The stamp seed reads BOTH tables — what this device issued and what it
      // observed — so the fake has to answer from both too.
      if (sql.includes("MAX(hlc)")) {
        const last = outbox[outbox.length - 1]
        const seen = [...(last ? [last.hlc] : []), ...docHlc.values()]
        const max = seen.reduce<string | null>(
          (best, h) => (best === null || h > best ? h : best),
          null
        )
        return [{ hlc: max }] as T[]
      }
      if (sql.includes("FROM sync_doc_hlc")) {
        const key = `${String(params?.[0])} ${String(params?.[1])}`
        return (docHlc.has(key) ? [{ one: 1 }] : []) as T[]
      }
      if (sql.includes("FROM outbox")) {
        const last = outbox[outbox.length - 1]
        return (last ? [{ hlc: last.hlc }] : []) as T[]
      }
      if (sql.includes("FROM listening_sessions")) {
        const row = sessions.get(String(params?.[0]))
        return (row ? [row] : []) as T[]
      }
      if (sql.includes("FROM playlist_items")) {
        // journalSession resolves the natural track_id from the playlist item.
        const row = playlist.get(String(params?.[0]))
        return (row ? [{ track_id: row.track_id }] : []) as T[]
      }
      return []
    },
    async execute(sql: string, params?: QueryParams): Promise<void> {
      if (sql.includes("INSERT INTO outbox")) {
        const p = params ?? []
        outbox.push({
          id: ++seq,
          collection: String(p[0]),
          doc_id: String(p[1]),
          op: String(p[2]),
          data: p[3] === null ? null : String(p[3]),
          hlc: String(p[4]),
          owner_id: p[6] == null ? null : String(p[6]),
        })
      }
    },
    async transaction(fn: () => Promise<void>): Promise<void> {
      await fn()
    },
    async save(): Promise<void> {},
    async close(): Promise<void> {},
  }
  return { db, outbox }
}

/** UnitOfWork that just runs the callback (transaction semantics are tested
 *  separately in reentrantUnitOfWork.test.ts). */
const passthroughUow: IUnitOfWork = { run: (fn) => fn() }

function stubNotes(): INoteRepository {
  const now = 1000
  return {
    getById: async () => null,
    listByTrack: async () => [],
    listRecent: async () => [],
    create: async (input): Promise<Note> => ({
      id: "note_1",
      trackId: input.trackId,
      text: input.text,
      timeStart: input.timeStart,
      timeEnd: input.timeEnd,
      createdAt: now,
      meta: input.meta ?? null,
    }),
    update: async (input): Promise<Note> => ({
      id: input.id,
      trackId: "t1",
      text: input.text ?? "x",
      timeStart: 0,
      timeEnd: 1,
      createdAt: now,
      meta: null,
    }),
    delete: async () => {},
    clearAll: async () => {},
  }
}

function stubPlaylist(): IPlaylistItemRepository {
  const store = new Map<string, PlaylistItem>()
  return {
    getById: async (id) => store.get(id) ?? null,
    listActive: async () => [],
    listArchived: async () => [],
    add: async (trackId, collectionId): Promise<PlaylistItem> => {
      const item: PlaylistItem = {
        id: `pl_${trackId}`,
        trackId,
        addedAt: 111,
        archivedAt: null,
        collectionId: collectionId ?? null,
      }
      store.set(item.id, item)
      return item
    },
    archive: async (id) => {
      const cur = store.get(id)
      if (cur) store.set(id, { ...cur, archivedAt: 222 })
    },
    remove: async (id) => {
      store.delete(id)
    },
    clearAll: async () => {},
  }
}

function stubSessions(rows: Map<string, ListeningSessionRow>): IListeningSessionRepository {
  const base = {
    start: async () => "ls_1",
    forceStart: async () => "ls_1",
    tick: async () => {},
    finish: async () => {},
    finishAt: async () => {},
    getLastSessionForItem: async () => null,
    getResumePositionForItem: async () => null,
    getProgressForItems: async () => new Map(),
    getCompletedAtForItems: async () => new Map(),
    getDailyTotals: async () => [],
    getDailyTotalsByDayOffset: async () => [],
    hasAny: async () => false,
    getTotalListenedSeconds: async () => 0,
    listRecentTracksWithProgress: async () => [],
    getTracksListenedInRange: async () => [],
    clearAll: async () => {},
  }
  void rows
  return base as unknown as IListeningSessionRepository
}

/** Chat stubs — the non-chat decorator tests never call these, they only
 *  satisfy the (now required) chat repos in the wrapped bundle. */
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

function stubLibraryMemberships(): ILibraryMembershipRepository {
  return {
    listArchivedIds: async () => new Set<string>(),
    getById: async () => null,
    setArchived: async () => {},
    setActive: async () => {},
    clearAll: async () => {},
  }
}

describe("withSyncJournaling", () => {
  let sessions: Map<string, ListeningSessionRow>
  let playlist: Map<string, { id: string; track_id: string }>
  /** Server HLCs this device has already pulled and recorded. */
  let docHlc: Map<string, string>
  let db: IDatabase
  let outbox: OutboxRow[]
  let repos: ReturnType<typeof withSyncJournaling>
  /** The account journaling now — the decorator reads it per write. */
  let owner: string | null

  beforeEach(() => {
    owner = null
    sessions = new Map()
    playlist = new Map()
    docHlc = new Map()
    const fake = makeFakeDb(sessions, playlist, docHlc)
    db = fake.db
    outbox = fake.outbox
    repos = withSyncJournaling(
      {
        notes: stubNotes(),
        playlistItems: stubPlaylist(),
        listeningSessions: stubSessions(sessions),
        chatSessions: stubChatSessions(),
        chatMessages: stubChatMessages(),
        libraryMemberships: stubLibraryMemberships(),
      },
      {
        userDb: db,
        unitOfWork: passthroughUow,
        getDeviceId: async () => "dev-test",
        getOwnerId: () => owner,
      }
    )
  })

  it("stamps each row with the account that journaled it", async () => {
    owner = "user-1"
    await repos.notes.create({ trackId: "t1", text: "before", timeStart: 0, timeEnd: 5 })
    // Account deleted → the device is a fresh anonymous identity; the journal
    // survives, so only the stamp separates the two owners (#1497).
    owner = "anon-2"
    await repos.notes.create({ trackId: "t1", text: "after", timeStart: 0, timeEnd: 5 })

    expect(outbox.map((r) => r.owner_id)).toEqual(["user-1", "anon-2"])
  })

  it("journals a row unowned while no identity is resolved yet", async () => {
    await repos.notes.create({ trackId: "t1", text: "hi", timeStart: 0, timeEnd: 5 })
    expect(outbox[0]!.owner_id).toBeNull()
  })

  it("journals a note create as an upsert keyed on the note id", async () => {
    await repos.notes.create({ trackId: "t1", text: "hi", timeStart: 0, timeEnd: 5 })
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ collection: "notes", doc_id: "note_1", op: "upsert" })
    expect(JSON.parse(outbox[0]!.data!)).toMatchObject({ id: "note_1", track_id: "t1", text: "hi" })
  })

  it("journals a note delete as a tombstone with null data", async () => {
    await repos.notes.delete("note_9")
    expect(outbox[0]).toMatchObject({ collection: "notes", doc_id: "note_9", op: "delete" })
    expect(outbox[0]!.data).toBeNull()
  })

  it("keys playlist journals on track_id, not the local pl_ surrogate", async () => {
    await repos.playlistItems.add("track-42", null)
    expect(outbox[0]).toMatchObject({
      collection: "playlist_items",
      doc_id: "track-42",
      op: "upsert",
    })
    expect(JSON.parse(outbox[0]!.data!)).toMatchObject({ track_id: "track-42", added_at: 111 })
  })

  it("journals archive as an upsert carrying the new archived_at", async () => {
    const item = await repos.playlistItems.add("track-7", null)
    await repos.playlistItems.archive(item.id)
    expect(outbox).toHaveLength(2)
    expect(outbox[1]).toMatchObject({
      collection: "playlist_items",
      doc_id: "track-7",
      op: "upsert",
    })
    expect(JSON.parse(outbox[1]!.data!)).toMatchObject({ archived_at: 222 })
  })

  it("journals remove as a delete keyed on the track_id read before deletion", async () => {
    const item = await repos.playlistItems.add("track-9", null)
    await repos.playlistItems.remove(item.id)
    expect(outbox[1]).toMatchObject({
      collection: "playlist_items",
      doc_id: "track-9",
      op: "delete",
    })
    expect(outbox[1]!.data).toBeNull()
  })

  it("journals a closed session on finish, not on start/tick", async () => {
    sessions.set("ls_5", {
      id: "ls_5",
      item_id: "pl_1",
      started_at: 10,
      ended_at: 20,
      from_position: 0,
      to_position: 30,
    })
    playlist.set("pl_1", { id: "pl_1", track_id: "track-77" })
    await repos.listeningSessions.start({ itemId: "pl_1", position: 0 })
    await repos.listeningSessions.tick("ls_5", { position: 15 })
    expect(outbox).toHaveLength(0)
    await repos.listeningSessions.finish("ls_5", { position: 30 })
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({
      collection: "listening_sessions",
      doc_id: "ls_5",
      op: "upsert",
    })
    // Job 2: the snapshot carries the stable track_id (resolved via the
    // playlist item) alongside the local item_id.
    expect(JSON.parse(outbox[0]!.data!)).toMatchObject({
      item_id: "pl_1",
      track_id: "track-77",
      to_position: 30,
    })
  })

  it("stamps a strictly increasing HLC across successive writes", async () => {
    await repos.notes.create({ trackId: "t1", text: "a", timeStart: 0, timeEnd: 1 })
    await repos.notes.create({ trackId: "t1", text: "b", timeStart: 0, timeEnd: 1 })
    await repos.notes.create({ trackId: "t1", text: "c", timeStart: 0, timeEnd: 1 })
    expect(outbox).toHaveLength(3)
    expect(compareHlcString(outbox[1]!.hlc, outbox[0]!.hlc)).toBeGreaterThan(0)
    expect(compareHlcString(outbox[2]!.hlc, outbox[1]!.hlc)).toBeGreaterThan(0)
  })

  it("stamps above a remote HLC already pulled, even from a doc it never touched", async () => {
    // The other phone's clock runs ten minutes fast. Its edit was pulled and
    // its stamp recorded, so this device has OBSERVED a clock that far ahead —
    // and `hlcNow`'s seed is "issued or observed". Seeding from the outbox tail
    // alone stamps the edit below the change it descends from; the server takes
    // the push anyway (it gates on `base_hlc`, not on ordering), and pull-side
    // LWW then keeps the older text on every device (#1628).
    const remote = hlcToString({
      physical: Date.now() + 600_000,
      counter: 0,
      deviceId: "dev-ahead",
    })
    docHlc.set("notes note_remote", remote)

    await repos.notes.create({ trackId: "t1", text: "local edit", timeStart: 0, timeEnd: 1 })

    expect(outbox).toHaveLength(1)
    expect(compareHlcString(outbox[0]!.hlc, remote)).toBeGreaterThan(0)
  })

  it("keeps stamping above the observed clock on the writes that follow", async () => {
    // The seed is re-read per write, so the second stamp must clear the remote
    // one too — not fall back to the wall clock once an outbox tail exists.
    const remote = hlcToString({
      physical: Date.now() + 600_000,
      counter: 0,
      deviceId: "dev-ahead",
    })
    docHlc.set("notes note_remote", remote)

    await repos.notes.create({ trackId: "t1", text: "a", timeStart: 0, timeEnd: 1 })
    await repos.notes.create({ trackId: "t1", text: "b", timeStart: 0, timeEnd: 1 })

    expect(compareHlcString(outbox[1]!.hlc, remote)).toBeGreaterThan(0)
    expect(compareHlcString(outbox[1]!.hlc, outbox[0]!.hlc)).toBeGreaterThan(0)
  })

  it("does not journal clearAll (local data-wipe path)", async () => {
    await repos.notes.clearAll()
    await repos.playlistItems.clearAll()
    await repos.listeningSessions.clearAll()
    expect(outbox).toHaveLength(0)
  })
})

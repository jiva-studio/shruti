import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { SyncDoc } from "@lib/domain"
import { createInMemoryTestDatabase } from "./testDb.js"
import { createSqlSyncApplyRepository } from "../syncApplyRepository.sql.js"
import { createSqlLibraryItemRepository } from "../libraryItemsRepository.sql.js"
import type { LibraryItemWire } from "../syncWire.js"

/**
 * Proves the acceptance bar of #1228: a `library_items` change pulled from the
 * server (server-owned, pull-only) applies onto `user.db` and reads back out as
 * a playable synthetic Track through the existing repository/adapter, keyed by
 * content hash. Also exercises the wire↔column mapping and the server-authored
 * tombstone.
 */

const HLC_A = "000000001000000:00001:dev-A"
const HLC_B = "000000002000000:00001:dev-B"

async function applySchema(db: IDatabase): Promise<void> {
  // Mirror the 017 migration DDL the sync-apply adapter writes into.
  await db.execute(`CREATE TABLE library_items (
    id TEXT PRIMARY KEY, track_id TEXT, status TEXT NOT NULL, origin TEXT,
    title_raw TEXT, author_raw TEXT, location_raw TEXT, date_raw TEXT, lang_hint TEXT,
    author_id TEXT, location_id TEXT, date TEXT, date_precision TEXT,
    lang TEXT, lang_confidence REAL, error TEXT, audio_key TEXT, transcript_key TEXT,
    duration INTEGER, cover_key TEXT, references_json TEXT, description TEXT, outline_json TEXT,
    source_url TEXT, created_at INTEGER, updated_at INTEGER
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
}

function wire(overrides: Partial<LibraryItemWire> = {}): LibraryItemWire {
  return {
    id: "mem-1",
    track_id: "hash-abc",
    status: "ready",
    origin: "private",
    title_raw: "A lecture",
    author_raw: "Swami",
    location_raw: null,
    date_raw: "1972",
    lang_hint: "en",
    author_id: "author-9",
    location_id: null,
    date: "1972-01-01",
    date_precision: "year",
    lang: "en",
    lang_confidence: 0.98,
    error: null,
    audio_key: null,
    transcript_key: null,
    duration: 3_600_000,
    cover_key: null,
    references: null,
    description: null,
    outline: null,
    source_url: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  }
}

function upsertDoc(docId: string, hlc: string, data: unknown): SyncDoc<unknown> {
  return { docId, hlc, deleted: false, data }
}
function deleteDoc(docId: string, hlc: string): SyncDoc<unknown> {
  return { docId, hlc, deleted: true, data: null }
}

describe("library_items — pull-only apply + synthetic Track read path", () => {
  let db: IDatabase
  let apply: ReturnType<typeof createSqlSyncApplyRepository>
  let repo: ReturnType<typeof createSqlLibraryItemRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    apply = createSqlSyncApplyRepository(db)
    repo = createSqlLibraryItemRepository(db)
  })

  it("applies a pulled row and reads it back as a playable Track by content hash", async () => {
    await apply.applyRemote("library_items", upsertDoc("mem-1", HLC_A, wire()), HLC_A)

    const item = await repo.getByTrackId("hash-abc")
    expect(item).not.toBeNull()
    expect(item!.id).toBe("mem-1")
    expect(item!.status).toBe("ready")
    expect(item!.duration).toBe(3_600_000)

    const track = await repo.getTrackByTrackId("hash-abc")
    expect(track).not.toBeNull()
    expect(track!.id).toBe("hash-abc")
    expect(track!.variants[0]!.audio?.path).toBe("public/tracks/hash-abc/audio/original.mp3")
    expect(track!.variants[0]!.transcript?.path).toBe("public/tracks/hash-abc/transcripts/en.json")

    // The server HLC pointer advanced so the change isn't re-processed.
    expect(await apply.lastServerHlc("library_items", "mem-1")).toBe(HLC_A)
  })

  it("round-trips every wire column onto the row (getById mirrors the projection)", async () => {
    await apply.applyRemote(
      "library_items",
      upsertDoc(
        "mem-2",
        HLC_A,
        wire({
          id: "mem-2",
          track_id: "hash-2",
          audio_key: "public/tracks/hash-2/audio/clean.mp3",
          transcript_key: "public/tracks/hash-2/transcripts/ru.json",
          lang: "ru",
          cover_key: "public/tracks/hash-2/cover.jpg",
        })
      ),
      HLC_A
    )
    const item = await repo.getById("mem-2")
    expect(item).toMatchObject({
      id: "mem-2",
      trackId: "hash-2",
      audioKey: "public/tracks/hash-2/audio/clean.mp3",
      transcriptKey: "public/tracks/hash-2/transcripts/ru.json",
      lang: "ru",
      coverKey: "public/tracks/hash-2/cover.jpg",
    })
  })

  it("re-applies the server's version wholesale on a later update (pull-only)", async () => {
    await apply.applyRemote(
      "library_items",
      upsertDoc("mem-1", HLC_A, wire({ status: "processing", track_id: null, duration: null })),
      HLC_A
    )
    expect((await repo.getById("mem-1"))!.status).toBe("processing")

    // Server flips it to ready with the fetched content hash + keys.
    await apply.applyRemote(
      "library_items",
      upsertDoc("mem-1", HLC_B, wire({ status: "ready" })),
      HLC_B
    )
    const item = await repo.getById("mem-1")
    expect(item!.status).toBe("ready")
    expect(item!.trackId).toBe("hash-abc")
    // Only one row — the update replaced in place.
    expect(await repo.listAll()).toHaveLength(1)
  })

  it("removes the row on a server-authored tombstone", async () => {
    await apply.applyRemote("library_items", upsertDoc("mem-1", HLC_A, wire()), HLC_A)
    expect(await repo.listAll()).toHaveLength(1)

    await apply.applyRemote("library_items", deleteDoc("mem-1", HLC_B), HLC_B)
    expect(await repo.listAll()).toHaveLength(0)
    expect(await repo.getTrackByTrackId("hash-abc")).toBeNull()
  })
})

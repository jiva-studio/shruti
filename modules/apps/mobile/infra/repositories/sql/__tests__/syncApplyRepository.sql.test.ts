import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { SyncDoc } from "@lib/domain"
import { createInMemoryTestDatabase } from "./testDb.js"
import { createSqlSyncApplyRepository } from "../syncApplyRepository.sql.js"

/**
 * Tests for the remote-apply adapter's Lane G + listening-attribution
 * behaviours: chat tombstone cascade, orphan-drop, and re-keying a pulled
 * listening session onto the correct LOCAL track via its `track_id`.
 */

const HLC_A = "000000001000000:00001:dev-A"
const HLC_B = "000000002000000:00001:dev-B"

async function applySchema(db: IDatabase): Promise<void> {
  // Mirror the real user.db: foreign_keys ON + the chat FK cascade (migration
  // 007). Without these the harness silently diverged from production and hid
  // the INSERT-OR-REPLACE-cascades-messages bug.
  await db.execute("PRAGMA foreign_keys = ON")
  await db.execute(`CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, track_id TEXT
  )`)
  await db.execute(`CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL, created_at INTEGER NOT NULL,
    meta TEXT NOT NULL DEFAULT '{"_v":1,"data":{}}',
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
  )`)
  await db.execute(`CREATE TABLE playlist_items (
    id TEXT PRIMARY KEY, track_id TEXT NOT NULL, added_at INTEGER NOT NULL,
    archived_at INTEGER, collection_id TEXT
  )`)
  await db.execute(`CREATE TABLE listening_sessions (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL, from_position INTEGER NOT NULL, to_position INTEGER NOT NULL
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

function upsertDoc(docId: string, hlc: string, data: unknown): SyncDoc<unknown> {
  return { docId, hlc, deleted: false, data }
}
function deleteDoc(docId: string, hlc: string): SyncDoc<unknown> {
  return { docId, hlc, deleted: true, data: null }
}

describe("createSqlSyncApplyRepository — chat + listening apply", () => {
  let db: IDatabase
  let apply: ReturnType<typeof createSqlSyncApplyRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    apply = createSqlSyncApplyRepository(db)
  })

  it("cascades a session delete to its messages (tombstone-per-session)", async () => {
    await apply.applyRemote(
      "chat_sessions",
      upsertDoc("s1", HLC_A, {
        id: "s1",
        title: "T",
        created_at: 1,
        updated_at: 1,
        track_id: null,
      }),
      HLC_A
    )
    for (const mid of ["m1", "m2"]) {
      await apply.applyRemote(
        "chat_messages",
        upsertDoc(mid, HLC_A, {
          id: mid,
          session_id: "s1",
          role: "user",
          content: "x",
          created_at: 1,
          meta: null,
        }),
        HLC_A
      )
    }
    expect(await db.query("SELECT id FROM chat_messages WHERE session_id = 's1'")).toHaveLength(2)

    await apply.applyRemote("chat_sessions", deleteDoc("s1", HLC_B), HLC_B)

    expect(await db.query("SELECT id FROM chat_sessions WHERE id = 's1'")).toHaveLength(0)
    expect(await db.query("SELECT id FROM chat_messages WHERE session_id = 's1'")).toHaveLength(0)
  })

  it("keeps messages when a later session upsert re-applies over them", async () => {
    // The real pull interleaving: a session's title/updated_at change is
    // ordered AFTER its messages under the single cursor. Re-applying the
    // session must NOT wipe the messages (INSERT OR REPLACE would DELETE the
    // row and the FK cascade would take the messages with it).
    await apply.applyRemote(
      "chat_sessions",
      upsertDoc("s1", HLC_A, {
        id: "s1",
        title: "T",
        created_at: 1,
        updated_at: 1,
        track_id: null,
      }),
      HLC_A
    )
    for (const mid of ["m1", "m2"]) {
      await apply.applyRemote(
        "chat_messages",
        upsertDoc(mid, HLC_A, {
          id: mid,
          session_id: "s1",
          role: "user",
          content: "x",
          created_at: 1,
          meta: null,
        }),
        HLC_A
      )
    }
    expect(await db.query("SELECT id FROM chat_messages WHERE session_id = 's1'")).toHaveLength(2)

    // Session re-applied (title + updated_at bumped) — the ordering that killed
    // the chats after a from-scratch sync.
    await apply.applyRemote(
      "chat_sessions",
      upsertDoc("s1", HLC_B, {
        id: "s1",
        title: "T2",
        created_at: 1,
        updated_at: 2,
        track_id: null,
      }),
      HLC_B
    )

    expect(await db.query("SELECT id FROM chat_messages WHERE session_id = 's1'")).toHaveLength(2)
    const [row] = await db.query<{ title: string }>(
      "SELECT title FROM chat_sessions WHERE id = 's1'"
    )
    expect(row?.title).toBe("T2")
  })

  it("drops an orphan message whose session is absent / tombstoned", async () => {
    // No parent session exists → the message upsert is dropped.
    await apply.applyRemote(
      "chat_messages",
      upsertDoc("m-orphan", HLC_A, {
        id: "m-orphan",
        session_id: "ghost",
        role: "assistant",
        content: "late",
        created_at: 5,
        meta: null,
      }),
      HLC_A
    )
    expect(await db.query("SELECT id FROM chat_messages")).toHaveLength(0)
    // Server-HLC bookkeeping still advanced so we don't re-process it.
    expect(await apply.lastServerHlc("chat_messages", "m-orphan")).toBe(HLC_A)
  })

  it("re-keys a pulled listening session onto the correct LOCAL track via track_id", async () => {
    // This device already has the track in its library under a LOCAL surrogate.
    await db.execute(
      "INSERT INTO playlist_items (id, track_id, added_at, archived_at) VALUES ('pl_local', 'track-XYZ', 1, NULL)"
    )
    // A session pulled from another device carries THAT device's item_id.
    await apply.applyRemote(
      "listening_sessions",
      upsertDoc("ls_remote", HLC_A, {
        id: "ls_remote",
        item_id: "pl_other_device",
        track_id: "track-XYZ",
        started_at: 10,
        ended_at: 20,
        from_position: 0,
        to_position: 30,
      }),
      HLC_A
    )
    // The session's item_id was rewritten to the local playlist item, so it
    // joins to the right track in the progress query.
    const rows = await db.query<{ item_id: string; track_id: string }>(
      `SELECT ls.item_id AS item_id, pi.track_id AS track_id
         FROM listening_sessions ls
         JOIN playlist_items pi ON pi.id = ls.item_id
        WHERE ls.id = 'ls_remote'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ item_id: "pl_local", track_id: "track-XYZ" })
  })

  it("keeps the remote item_id when the track isn't in this device's library yet", async () => {
    await apply.applyRemote(
      "listening_sessions",
      upsertDoc("ls_remote", HLC_A, {
        id: "ls_remote",
        item_id: "pl_other_device",
        track_id: "track-not-here",
        started_at: 10,
        ended_at: 20,
        from_position: 0,
        to_position: 30,
      }),
      HLC_A
    )
    const rows = await db.query<{ item_id: string }>(
      "SELECT item_id FROM listening_sessions WHERE id = 'ls_remote'"
    )
    expect(rows[0]?.item_id).toBe("pl_other_device")
  })
})

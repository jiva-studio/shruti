import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import { migration_027_playlist_items_unique_track } from "@infra/persistence/migrations/user/027_playlist_items_unique_track.js"
import { createSqlListeningSessionRepository } from "../listeningSessionsRepository.sql.js"
import { createSqlPlaylistItemRepository } from "../playlistItemsRepository.sql.js"
import { applyUserSchemaForTests, createInMemoryTestDatabase } from "./testDb.js"

const TRACK = "trk-1" as TrackId

/**
 * `playlist_items` holds ONE row per `track_id` (migration 027), so re-adding a
 * track that was archived earlier has to resurrect its row — the second row it
 * used to insert is a document the wire cannot express, and the archived one
 * is where the track's listening history lives (#1736).
 */
describe("createSqlPlaylistItemRepository — one row per track", () => {
  let db: IDatabase
  let repo: IPlaylistItemRepository

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
    await migration_027_playlist_items_unique_track.up(db)
    repo = createSqlPlaylistItemRepository(db)
  })

  it("resurrects the archived row on re-add instead of inserting a second one", async () => {
    const first = await repo.add(TRACK, "col-1")
    await repo.archive(first.id)
    // Progress the user built up before archiving — it hangs off the item id.
    await db.execute(
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_1', ?, 10, 20, 0, 900)`,
      [first.id]
    )

    const again = await repo.add(TRACK)

    expect(again.id).toBe(first.id)
    expect(again.archivedAt).toBeNull()
    // Provenance follows the newest add but keeps a non-null — same rule the
    // add-wins merge applies.
    expect(again.collectionId).toBe("col-1")
    expect((await repo.listActive()).map((i) => i.id)).toEqual([first.id])
    expect(await repo.listArchived()).toEqual([])
    // The listen survives the round trip: it still keys onto the live row.
    const [row] = await db.query<{ hwm: number | null }>(
      "SELECT MAX(to_position) AS hwm FROM listening_sessions WHERE item_id = ?",
      [first.id]
    )
    expect(row?.hwm).toBe(900)
  })

  it("bumps added_at so the resurrected item sorts as a fresh add", async () => {
    const first = await repo.add(TRACK)
    await repo.archive(first.id)

    const again = await repo.add(TRACK)

    expect(again.addedAt).toBeGreaterThanOrEqual(first.addedAt)
  })

  it("still inserts a fresh row for a track that was never added", async () => {
    const a = await repo.add(TRACK)
    const b = await repo.add("trk-2" as TrackId)

    expect(a.id).not.toBe(b.id)
    expect((await repo.listActive()).map((i) => i.trackId).sort()).toEqual(["trk-1", "trk-2"])
  })

  it("removes the row outright, so a later add starts a new one", async () => {
    const first = await repo.add(TRACK)
    await repo.remove(first.id as PlaylistItemId)

    const again = await repo.add(TRACK)

    expect(again.id).not.toBe(first.id)
    expect((await repo.listActive()).map((i) => i.id)).toEqual([again.id])
  })
})

/**
 * The two surfaces must disagree ON PURPOSE (LECTORIUM-18/19): re-adding a
 * finished lecture starts a FRESH pass on Home — no completed badge, no
 * progress, resume from the top — while Library keeps the lifetime "listened"
 * badge so the user can still see they have heard it before.
 *
 * That used to fall out of the schema: a re-add INSERTed a second row, so the
 * new item id had no history and the archived row kept the lifetime one. With
 * one row per `track_id` (#1736) the id survives the cycle, so the boundary is
 * `added_at` and the lifetime question is a separate query. This is the
 * invariant that had no unit test — only the e2e caught it.
 */
describe("archive → re-add: fresh current pass, lifetime badge survives", () => {
  const DURATION_SEC = 3000
  let db: IDatabase
  let items: IPlaylistItemRepository
  let sessions: IListeningSessionRepository

  /** The item as the user left it: added a while ago, listened to the end. */
  async function seedFinishedItem(): Promise<PlaylistItemId> {
    const item = await items.add(TRACK)
    const id = item.id as PlaylistItemId
    // Backdate the add so the listen below lands INSIDE the first pass —
    // `add` stamps `Date.now()`, and a test must not race the wall clock.
    await db.execute("UPDATE playlist_items SET added_at = ? WHERE id = ?", [
      Date.now() - 3_600_000,
      id,
    ])
    const endedAt = Math.floor(Date.now() / 1000) - 60
    await db.execute(
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_1', ?, ?, ?, 0, ?)`,
      [id, endedAt - DURATION_SEC, endedAt, DURATION_SEC]
    )
    return id
  }

  const durations = (id: PlaylistItemId) => new Map([[id, DURATION_SEC]])

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
    await migration_027_playlist_items_unique_track.up(db)
    items = createSqlPlaylistItemRepository(db)
    sessions = createSqlListeningSessionRepository(db, {
      run: <T>(fn: () => Promise<T>) => fn(),
    })
  })

  it("reports the lecture finished while it is still the current pass", async () => {
    const id = await seedFinishedItem()

    expect((await sessions.getCompletedAtForItems([id], durations(id))).get(id)).not.toBeNull()
    expect(await sessions.getResumePositionForItem(id)).toBe(DURATION_SEC)
    expect(await sessions.listEverCompletedItems([id], durations(id))).toContain(id)
  })

  it("keeps the lifetime badge after archiving", async () => {
    const id = await seedFinishedItem()
    await items.archive(id)

    expect(await sessions.listEverCompletedItems([id], durations(id))).toContain(id)
  })

  it("starts a fresh pass on re-add — no completion, no progress, resume from the top", async () => {
    const id = await seedFinishedItem()
    await items.archive(id)

    const readded = await items.add(TRACK)

    // Same row — the invariant this PR enforces.
    expect(readded.id).toBe(id)
    // …but the previous pass no longer counts toward it.
    expect((await sessions.getCompletedAtForItems([id], durations(id))).get(id) ?? null).toBeNull()
    expect((await sessions.getProgressForItems([id])).get(id)).toBeUndefined()
    expect(await sessions.getResumePositionForItem(id)).toBeNull()
  })

  it("keeps the lifetime badge after the re-add — the two surfaces disagree", async () => {
    const id = await seedFinishedItem()
    await items.archive(id)
    await items.add(TRACK)

    expect(await sessions.listEverCompletedItems([id], durations(id))).toContain(id)
  })

  it("counts the new pass once the user finishes it again", async () => {
    const id = await seedFinishedItem()
    await items.archive(id)
    await items.add(TRACK)
    const endedAt = Math.floor(Date.now() / 1000) + 600
    await db.execute(
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_2', ?, ?, ?, 0, ?)`,
      [id, endedAt - 600, endedAt, DURATION_SEC]
    )

    expect((await sessions.getCompletedAtForItems([id], durations(id))).get(id)).toBe(endedAt)
    expect(await sessions.getResumePositionForItem(id)).toBe(DURATION_SEC)
  })

  it("leaves a session with no playlist row of its own in scope", async () => {
    // Playback outside the playlist writes a synthetic `track:<id>` item id,
    // which has no `added_at` to bound a pass.
    const synthetic = "track:trk-9" as PlaylistItemId
    await db.execute(
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES ('ls_syn', ?, 10, 20, 0, 500)`,
      [synthetic]
    )

    expect(await sessions.getResumePositionForItem(synthetic)).toBe(500)
    expect((await sessions.getProgressForItems([synthetic])).get(synthetic)?.position).toBe(500)
  })
})

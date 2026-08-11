import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import { migration_027_playlist_items_unique_track } from "@infra/persistence/migrations/user/027_playlist_items_unique_track.js"
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

import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlCollectionRepository } from "../collectionsRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/**
 * Issue #1741 (7): `collectionsRepository` carried no `hidden` reference at
 * all, while every query in `tracksRepository` filters it. `CollectionView`
 * asks for the collection's track ids and hands them to `tracks.getByIds`,
 * which drops the hidden ones — so the page rendered fewer rows than it asked
 * for, "Add all" queued fewer lectures than it implied, and the "lecture N of
 * M" label counted rows the list never showed.
 */

async function applySchema(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE tracks (
       id TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0, author_id TEXT)`
  )
  await db.execute(`CREATE TABLE authors (
    id TEXT NOT NULL, language TEXT NOT NULL, full_name TEXT NOT NULL,
    image TEXT, description TEXT, PRIMARY KEY (id, language))`)
  await db.execute(`CREATE TABLE collections (
    id TEXT NOT NULL, language TEXT NOT NULL, name TEXT NOT NULL,
    cover TEXT, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, language))`)
  await db.execute(`CREATE TABLE collection_tracks (
    collection_id TEXT NOT NULL, collection_language TEXT NOT NULL,
    track_id TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY (collection_id, collection_language, track_id))`)
}

/** Seminar `c1`: five lectures, of which the 2nd and 5th are hidden. */
async function seed(db: IDatabase): Promise<void> {
  const tracks: [string, number, string][] = [
    ["t1", 0, "a1"],
    ["t2", 1, "a2"],
    ["t3", 0, "a1"],
    ["t4", 0, "a1"],
    ["t5", 1, "a2"],
  ]
  for (const [id, hidden, author] of tracks) {
    await db.execute("INSERT INTO tracks (id, hidden, author_id) VALUES (?, ?, ?)", [
      id,
      hidden,
      author,
    ])
  }
  await db.execute(
    "INSERT INTO authors (id, language, full_name) VALUES ('a1','en','Visible Author')"
  )
  await db.execute(
    "INSERT INTO authors (id, language, full_name) VALUES ('a2','en','Hidden-only Author')"
  )
  await db.execute(
    "INSERT INTO collections (id, language, name, sort_order) VALUES ('c1','en','Seminar',0)"
  )
  let position = 0
  for (const [id] of tracks) {
    await db.execute(
      `INSERT INTO collection_tracks (collection_id, collection_language, track_id, position)
       VALUES ('c1', 'en', ?, ?)`,
      [id, position++]
    )
  }
}

describe("collectionsRepository — hidden tracks", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlCollectionRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    await seed(db)
    repo = createSqlCollectionRepository(db)
  })

  it("getCollectionTrackIds leaves them out", async () => {
    expect(await repo.getCollectionTrackIds("c1", "en")).toEqual(["t1", "t3", "t4"])
  })

  it("getCollection returns the same visible list", async () => {
    const detail = await repo.getCollection("c1", "en")
    expect(detail?.trackIds).toEqual(["t1", "t3", "t4"])
  })

  it("counts the track's place among the lectures the page actually shows", async () => {
    // t4 is the 5th row in `collection_tracks` but the 3rd of 3 visible ones —
    // "lecture 5 of 5" against a three-row list is what the user saw.
    const rows = await repo.getCollectionsOfTrack("t4", "en")
    expect(rows).toHaveLength(1)
    expect(rows[0].position).toBe(3)
    expect(rows[0].total).toBe(3)
  })

  it("does not credit an author who only appears on hidden lectures", async () => {
    const authors = await repo.getCollectionAuthors("c1", "en")
    expect(authors.map((a) => a.name)).toEqual(["Visible Author"])
  })
})

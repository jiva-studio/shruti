import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlCollectionRepository } from "../collectionsRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

async function applyFullSchema(db: IDatabase): Promise<void> {
  await db.execute(
    `CREATE TABLE tracks (id TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0, author_id TEXT)`
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
  await db.execute(`CREATE TABLE collection_tags (
    collection_id TEXT NOT NULL, collection_language TEXT NOT NULL, tag_id TEXT NOT NULL)`)
  await db.execute(`CREATE TABLE collection_groups (
    id TEXT NOT NULL, language TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, language))`)
  await db.execute(`CREATE TABLE collection_group_items (
    group_id TEXT NOT NULL, group_language TEXT NOT NULL,
    collection_id TEXT NOT NULL, position INTEGER NOT NULL)`)
}

async function seed(db: IDatabase): Promise<void> {
  await db.execute(
    `INSERT INTO collections (id, language, name, cover, description, sort_order)
     VALUES ('c2','en','Second',NULL,NULL,2), ('c1','en','First','c1.jpg','On karma',1),
            ('c1','ru','Первая','c1.jpg','О карме',1)`
  )
  await db.execute(
    `INSERT INTO collection_tags (collection_id, collection_language, tag_id)
     VALUES ('c2','en','tag_featured'), ('c1','en','tag_other')`
  )
  await db.execute(
    `INSERT INTO collection_groups (id, language, name, description, sort_order)
     VALUES ('g1','en','Seminars','Long courses',0), ('g2','en','Shorts',NULL,1)`
  )
  await db.execute(
    `INSERT INTO collection_group_items (group_id, group_language, collection_id, position)
     VALUES ('g1','en','c2',0), ('g1','en','c1',1)`
  )
}

describe("collectionsRepository — reads", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlCollectionRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyFullSchema(db)
    await seed(db)
    repo = createSqlCollectionRepository(db)
  })

  it("lists only the featured collections of the locale", async () => {
    expect(await repo.listFeaturedCollections("en")).toEqual([
      { id: "c2", name: "Second", cover: "", sort_order: 2 },
    ])
  })

  it("lists every collection of the locale in display order", async () => {
    const rows = await repo.listCollections("en")
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2"])
    expect(rows[0]).toEqual({
      id: "c1",
      name: "First",
      cover: "c1.jpg",
      sort_order: 1,
      description: "On karma",
    })
  })

  it("reads an absent cover and description as empty strings", async () => {
    const [, second] = await repo.listCollections("en")
    expect(second).toMatchObject({ cover: "", description: "" })
  })

  it("names a collection in the asked-for locale", async () => {
    expect(await repo.getCollectionName("c1", "ru")).toBe("Первая")
    expect(await repo.getCollectionName("c1", "en")).toBe("First")
  })

  it("has no name for a collection missing from the locale", async () => {
    expect(await repo.getCollectionName("c2", "ru")).toBeNull()
    expect(await repo.getCollectionName("gone", "en")).toBeNull()
  })

  it("has no detail for a collection missing from the locale", async () => {
    expect(await repo.getCollection("c2", "ru")).toBeNull()
  })

  it("lists the groups of the locale", async () => {
    expect(await repo.listGroups("en")).toEqual([
      { id: "g1", name: "Seminars", description: "Long courses" },
      { id: "g2", name: "Shorts", description: "" },
    ])
  })

  it("keeps a group's own order rather than the collections' sort order", async () => {
    const rows = await repo.getGroupCollections("g1", "en")
    expect(rows.map((r) => r.id)).toEqual(["c2", "c1"])
  })

  it("has no collections for an unknown group", async () => {
    expect(await repo.getGroupCollections("g9", "en")).toEqual([])
  })
})

describe("collectionsRepository — an older bundled catalog", () => {
  it("reports no collections at all when the tables have not shipped yet", async () => {
    const db = await createInMemoryTestDatabase()
    const repo = createSqlCollectionRepository(db)

    expect(await repo.listFeaturedCollections("en")).toEqual([])
    expect(await repo.listCollections("en")).toEqual([])
    expect(await repo.getCollectionTrackIds("c1", "en")).toEqual([])
    expect(await repo.getCollection("c1", "en")).toBeNull()
    expect(await repo.getCollectionName("c1", "en")).toBeNull()
    expect(await repo.getCollectionAuthors("c1", "en")).toEqual([])
    expect(await repo.getCollectionsOfTrack("t1", "en")).toEqual([])
    expect(await repo.listGroups("en")).toEqual([])
    expect(await repo.getGroupCollections("g1", "en")).toEqual([])
  })

  it("credits no authors when the catalog predates the author profile columns", async () => {
    const db = await createInMemoryTestDatabase()
    await db.execute(`CREATE TABLE tracks (id TEXT PRIMARY KEY, hidden INTEGER, author_id TEXT)`)
    await db.execute(`CREATE TABLE authors (
      id TEXT NOT NULL, language TEXT NOT NULL, full_name TEXT NOT NULL,
      PRIMARY KEY (id, language))`)
    await db.execute(`CREATE TABLE collection_tracks (
      collection_id TEXT NOT NULL, collection_language TEXT NOT NULL,
      track_id TEXT NOT NULL, position INTEGER NOT NULL)`)

    expect(await createSqlCollectionRepository(db).getCollectionAuthors("c1", "en")).toEqual([])
  })

  it("lets an error that is not a schema gap surface", async () => {
    const boom = new Error("database disk image is malformed")
    const db = {
      query: () => Promise.reject(boom),
      execute: () => Promise.resolve(),
      transaction: () => Promise.resolve(),
      save: () => Promise.resolve(),
      close: () => Promise.resolve(),
    } as unknown as IDatabase

    await expect(createSqlCollectionRepository(db).listCollections("en")).rejects.toThrow(boom)
  })
})

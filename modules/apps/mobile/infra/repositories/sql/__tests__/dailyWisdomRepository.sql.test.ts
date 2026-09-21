import { beforeEach, describe, expect, it } from "vitest"

import type { IDatabase } from "@ports/app/index.js"

import { createSqlDailyWisdomRepository } from "../dailyWisdomRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

async function applySchema(db: IDatabase): Promise<void> {
  await db.execute(`CREATE TABLE daily_wisdom (
    id       TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    language TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms   INTEGER NOT NULL,
    text     TEXT NOT NULL,
    topic_id TEXT NOT NULL
  )`)
  await db.execute(`INSERT INTO daily_wisdom (id, track_id, language, start_ms, end_ms, text, topic_id)
    VALUES
      ('dw-en-1', 't-1', 'en', 1000, 5000, 'The soul is eternal.', 'soul'),
      ('dw-ru-1', 't-1', 'ru', 1000, 5000, 'Душа вечна.', 'soul')`)
}

describe("createSqlDailyWisdomRepository", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
  })

  it("reads one excerpt with its track, window and topic", async () => {
    const wisdom = await createSqlDailyWisdomRepository(db).byId("dw-en-1")

    expect(wisdom).toEqual({
      id: "dw-en-1",
      trackId: "t-1",
      language: "en",
      startMs: 1000,
      endMs: 5000,
      text: "The soul is eternal.",
      topicId: "soul",
    })
  })

  it("returns null for an id the catalog does not carry", async () => {
    expect(await createSqlDailyWisdomRepository(db).byId("dw-nope")).toBeNull()
  })

  it("lists every excerpt when no language is asked for", async () => {
    const all = await createSqlDailyWisdomRepository(db).list()

    expect(all.map((w) => w.id).sort()).toEqual(["dw-en-1", "dw-ru-1"])
  })

  it("lists only the asked-for language", async () => {
    const ru = await createSqlDailyWisdomRepository(db).list("ru")

    expect(ru.map((w) => w.id)).toEqual(["dw-ru-1"])
  })

  it("reads an older catalog without the table as having no excerpts", async () => {
    const bare = await createInMemoryTestDatabase()
    const repo = createSqlDailyWisdomRepository(bare)

    // The feature ships ahead of the catalog that carries it, so a missing
    // table is an empty day, not a crash on the home screen.
    expect(await repo.list()).toEqual([])
    expect(await repo.list("en")).toEqual([])
    expect(await repo.byId("dw-en-1")).toBeNull()
  })
})

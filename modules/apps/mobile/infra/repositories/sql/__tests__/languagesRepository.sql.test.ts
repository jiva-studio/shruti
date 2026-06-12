import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlLanguageRepository } from "../languagesRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

async function applySchema(db: IDatabase): Promise<void> {
  await db.execute(`CREATE TABLE languages (
    code      TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    icon      TEXT
  )`)
  await db.execute(`CREATE TABLE tracks (
    id     TEXT PRIMARY KEY,
    hidden INTEGER NOT NULL DEFAULT 0
  )`)
  await db.execute(`CREATE TABLE track_variants (
    track_id TEXT NOT NULL,
    language TEXT NOT NULL,
    PRIMARY KEY (track_id, language)
  )`)
}

describe("languagesRepository.sql — listWithTracks", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    await db.execute(`INSERT INTO languages (code, full_name) VALUES
      ('en', 'English'), ('ru', 'Russian'), ('hi', 'Hindi'), ('de', 'German')`)
    // en + ru have a non-hidden track; hi only has a hidden track; de has none.
    await db.execute(`INSERT INTO tracks (id, hidden) VALUES
      ('t1', 0), ('t2', 0), ('t3', 1)`)
    await db.execute(`INSERT INTO track_variants (track_id, language) VALUES
      ('t1', 'en'), ('t2', 'ru'), ('t3', 'hi')`)
  })

  it("returns only languages with at least one non-hidden track, ordered by code", async () => {
    const repo = createSqlLanguageRepository(db)
    const langs = await repo.listWithTracks()
    expect(langs.map((l) => l.code)).toEqual(["en", "ru"])
  })

  it("listAll still returns every language", async () => {
    const repo = createSqlLanguageRepository(db)
    const langs = await repo.listAll()
    expect(langs.map((l) => l.code)).toEqual(["de", "en", "hi", "ru"])
  })
})

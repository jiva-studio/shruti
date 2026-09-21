import { beforeEach, describe, expect, it } from "vitest"

import type { IDatabase } from "@ports/app/index.js"
import type { AuthorId, LocationId, SourceId, TagId } from "@lib/domain/core.js"

import { createSqlAuthorRepository } from "../authorsRepository.sql.js"
import { createSqlLocationRepository } from "../locationsRepository.sql.js"
import { createSqlSourceRepository } from "../sourcesRepository.sql.js"
import { createSqlTagRepository } from "../tagsRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/**
 * The four catalog dictionaries share a shape: one row per (id, language),
 * folded into an entity carrying a name per language.
 */
async function applySchema(db: IDatabase): Promise<void> {
  for (const table of ["authors", "locations", "tags"]) {
    await db.execute(`CREATE TABLE ${table} (
      id        TEXT NOT NULL,
      language  TEXT NOT NULL,
      full_name TEXT NOT NULL,
      PRIMARY KEY (id, language)
    )`)
  }
  await db.execute(`CREATE TABLE sources (
    id         TEXT NOT NULL,
    language   TEXT NOT NULL,
    full_name  TEXT NOT NULL,
    short_name TEXT NOT NULL,
    PRIMARY KEY (id, language)
  )`)
}

describe("catalog dictionary repositories", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    await db.execute(`INSERT INTO authors (id, language, full_name) VALUES
      ('ac', 'en', 'A. C. Bhaktivedanta Swami'),
      ('ac', 'ru', 'А. Ч. Бхактиведанта Свами'),
      ('bs', 'en', 'Bhaktisiddhanta Sarasvati')`)
    await db.execute(`INSERT INTO locations (id, language, full_name) VALUES
      ('bombay', 'en', 'Bombay'),
      ('bombay', 'ru', 'Бомбей'),
      ('london', 'en', 'London')`)
    await db.execute(`INSERT INTO tags (id, language, full_name) VALUES
      ('walk', 'en', 'Morning Walk'),
      ('walk', 'ru', 'Утренняя прогулка')`)
    await db.execute(`INSERT INTO sources (id, language, full_name, short_name) VALUES
      ('bg', 'en', 'Bhagavad-gita', 'BG'),
      ('bg', 'ru', 'Бхагавад-гита', 'БГ'),
      ('sb', 'en', 'Srimad Bhagavatam', 'SB')`)
  })

  describe("authors", () => {
    it("gathers every language of one author into a single entity", async () => {
      const author = await createSqlAuthorRepository(db).getById("ac" as AuthorId)

      expect(author?.id).toBe("ac")
      expect(author?.names.get("en")).toBe("A. C. Bhaktivedanta Swami")
      expect(author?.names.get("ru")).toBe("А. Ч. Бхактиведанта Свами")
    })

    it("returns null for an author the catalog does not carry", async () => {
      expect(await createSqlAuthorRepository(db).getById("nobody" as AuthorId)).toBeNull()
    })

    it("lists each author once, not once per language", async () => {
      const authors = await createSqlAuthorRepository(db).listAll()

      expect(authors.map((a) => a.id)).toEqual(["ac", "bs"])
      expect(authors[0].names.size).toBe(2)
    })
  })

  describe("locations", () => {
    it("gathers every language of one location", async () => {
      const location = await createSqlLocationRepository(db).getById("bombay" as LocationId)

      expect(location?.names.get("ru")).toBe("Бомбей")
    })

    it("returns null for an unknown location", async () => {
      expect(await createSqlLocationRepository(db).getById("mars" as LocationId)).toBeNull()
    })

    it("lists each location once", async () => {
      const locations = await createSqlLocationRepository(db).listAll()

      expect(locations.map((l) => l.id)).toEqual(["bombay", "london"])
    })
  })

  describe("tags", () => {
    it("gathers every language of one tag", async () => {
      const tag = await createSqlTagRepository(db).getById("walk" as TagId)

      expect(tag?.names.get("en")).toBe("Morning Walk")
      expect(tag?.names.get("ru")).toBe("Утренняя прогулка")
    })

    it("returns null for an unknown tag", async () => {
      expect(await createSqlTagRepository(db).getById("none" as TagId)).toBeNull()
    })

    it("lists each tag once", async () => {
      expect((await createSqlTagRepository(db).listAll()).map((t) => t.id)).toEqual(["walk"])
    })
  })

  describe("sources", () => {
    it("carries both the full and the short name per language", async () => {
      const source = await createSqlSourceRepository(db).getById("bg" as SourceId)

      expect(source?.names.get("en")).toEqual({ fullName: "Bhagavad-gita", shortName: "BG" })
      expect(source?.names.get("ru")).toEqual({ fullName: "Бхагавад-гита", shortName: "БГ" })
    })

    it("returns null for an unknown source", async () => {
      expect(await createSqlSourceRepository(db).getById("zz" as SourceId)).toBeNull()
    })

    it("lists each source once, ordered by id", async () => {
      const sources = await createSqlSourceRepository(db).listAll()

      expect(sources.map((s) => s.id)).toEqual(["bg", "sb"])
      expect(sources[0].names.size).toBe(2)
    })
  })
})

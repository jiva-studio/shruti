import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createSqlNoteRepository } from "../notesRepository.sql.js"
import { applyUserSchemaForTests, createInMemoryTestDatabase } from "./testDb.js"

describe("notesRepository.sql", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
  })

  it("creates, reads, lists, updates, and deletes a note", async () => {
    const repo = createSqlNoteRepository(db)

    const created = await repo.create({
      trackId: "track-1",
      text: "first note",
      timeStart: 10,
      timeEnd: 20,
    })
    expect(created.trackId).toBe("track-1")
    expect(created.text).toBe("first note")

    const fetched = await repo.getById(created.id)
    expect(fetched?.id).toBe(created.id)

    const byTrack = await repo.listByTrack("track-1")
    expect(byTrack).toHaveLength(1)

    await repo.update({ id: created.id, text: "edited" })
    const edited = await repo.getById(created.id)
    expect(edited?.text).toBe("edited")

    await repo.delete(created.id)
    expect(await repo.getById(created.id)).toBeNull()
  })

  it("listRecent orders by created_at DESC", async () => {
    const repo = createSqlNoteRepository(db)
    const a = await repo.create({ trackId: "t", text: "a", timeStart: 0, timeEnd: 1 })
    // Bump wall clock so the two notes have distinct created_at values.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = await repo.create({ trackId: "t", text: "b", timeStart: 1, timeEnd: 2 })

    const recent = await repo.listRecent(10)
    expect(recent.map((n) => n.id)).toEqual([b.id, a.id])
  })
})

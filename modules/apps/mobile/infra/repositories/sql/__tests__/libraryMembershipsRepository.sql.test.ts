import { beforeEach, describe, expect, it } from "vitest"

import type { IDatabase } from "@ports/app/index.js"
import type { ILibraryMembershipRepository } from "@lib/domain/ports/libraryMembershipRepository.js"

import { createSqlLibraryMembershipRepository } from "../libraryMembershipsRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

async function createMembershipsTable(db: IDatabase): Promise<void> {
  await db.execute(`CREATE TABLE library_memberships (
    id          TEXT PRIMARY KEY,
    archived_at INTEGER,
    updated_at  INTEGER
  )`)
}

describe("createSqlLibraryMembershipRepository", () => {
  let db: IDatabase
  let repo: ILibraryMembershipRepository

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await createMembershipsTable(db)
    repo = createSqlLibraryMembershipRepository(db)
  })

  const rowCount = async (): Promise<number> =>
    (await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM library_memberships"))[0].n

  it("reads an item nobody has acted on as absent, which means active", async () => {
    expect(await repo.getById("item-1")).toBeNull()
    expect((await repo.listArchivedIds()).size).toBe(0)
  })

  it("archives an item the user removed", async () => {
    await repo.setArchived("item-1")

    const membership = await repo.getById("item-1")
    expect(membership?.id).toBe("item-1")
    expect(membership?.archivedAt).toBeGreaterThan(0)
    expect([...(await repo.listArchivedIds())]).toEqual(["item-1"])
  })

  it("clears the archive stamp when the user adds the item back", async () => {
    await repo.setArchived("item-1")
    await repo.setActive("item-1")

    expect((await repo.getById("item-1"))?.archivedAt).toBeNull()
    expect((await repo.listArchivedIds()).size).toBe(0)
  })

  it("upserts rather than duplicating on a remove/re-add cycle", async () => {
    await repo.setArchived("item-1")
    await repo.setActive("item-1")
    await repo.setArchived("item-1")

    // A second row for the same id would make "absent = active" unreadable.
    expect(await rowCount()).toBe(1)
    expect([...(await repo.listArchivedIds())]).toEqual(["item-1"])
  })

  it("keeps an explicitly active row rather than deleting it", async () => {
    await repo.setActive("item-1")

    // The row records the user's intent for the merge; dropping it would let a
    // stale archive from another device win.
    expect(await rowCount()).toBe(1)
    expect(await repo.getById("item-1")).toEqual({ id: "item-1", archivedAt: null })
  })

  it("lists only the archived ids when both kinds are stored", async () => {
    await repo.setArchived("item-1")
    await repo.setActive("item-2")
    await repo.setArchived("item-3")

    expect([...(await repo.listArchivedIds())].sort()).toEqual(["item-1", "item-3"])
  })

  it("forgets every membership on clearAll", async () => {
    await repo.setArchived("item-1")
    await repo.setActive("item-2")

    await repo.clearAll()

    expect(await rowCount()).toBe(0)
    expect(await repo.getById("item-1")).toBeNull()
  })
})

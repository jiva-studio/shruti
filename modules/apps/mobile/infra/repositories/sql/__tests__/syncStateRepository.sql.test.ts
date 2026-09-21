import { beforeEach, describe, expect, it } from "vitest"

import type { IDatabase } from "@ports/app/index.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"

import { createSqlSyncStateRepository } from "../syncStateRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

async function createSyncStateTable(db: IDatabase): Promise<void> {
  await db.execute(`CREATE TABLE sync_state (
    device_id        TEXT    PRIMARY KEY,
    pull_cursor      INTEGER NOT NULL DEFAULT 0,
    acked_seq        INTEGER NOT NULL DEFAULT 0,
    pushed_outbox_id INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL DEFAULT 0
  )`)
}

describe("createSqlSyncStateRepository", () => {
  let db: IDatabase
  let repo: ISyncStateRepository
  let deviceIdReads: number

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await createSyncStateTable(db)
    deviceIdReads = 0
    repo = createSqlSyncStateRepository(db, async () => {
      deviceIdReads += 1
      return "device-1"
    })
  })

  const rowCount = async (): Promise<number> =>
    (await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM sync_state"))[0].n

  it("reads a device it has never seen as all zeros", async () => {
    expect(await repo.getPullCursor()).toBe(0)
    expect(await repo.getAckedSeq()).toBe(0)
    expect(await repo.getPushedOutboxId()).toBe(0)
  })

  it("does not create a row just by reading", async () => {
    await repo.getPullCursor()

    expect(await rowCount()).toBe(0)
  })

  it("keeps each cursor back across reads", async () => {
    await repo.setPullCursor(42)
    await repo.setAckedSeq(17)
    await repo.setPushedOutboxId(99)

    expect(await repo.getPullCursor()).toBe(42)
    expect(await repo.getAckedSeq()).toBe(17)
    expect(await repo.getPushedOutboxId()).toBe(99)
  })

  it("writes one row per device, not one per write", async () => {
    await repo.setPullCursor(1)
    await repo.setPullCursor(2)
    await repo.setAckedSeq(3)

    expect(await rowCount()).toBe(1)
    expect(await repo.getPullCursor()).toBe(2)
  })

  it("leaves the other cursors untouched when one advances", async () => {
    await repo.setAckedSeq(7)
    await repo.setPullCursor(5)

    // The three cursors advance independently; an UPSERT restating every
    // column would reset the two the caller did not name.
    expect(await repo.getAckedSeq()).toBe(7)
    expect(await repo.getPushedOutboxId()).toBe(0)
  })

  it("stamps updated_at on a write", async () => {
    const before = Date.now()
    await repo.setPullCursor(1)

    const rows = await db.query<{ updated_at: number }>("SELECT updated_at FROM sync_state")
    expect(rows[0].updated_at).toBeGreaterThanOrEqual(before)
  })

  it("keeps another device's cursors separate", async () => {
    await repo.setPullCursor(5)
    const other = createSqlSyncStateRepository(db, async () => "device-2")

    expect(await other.getPullCursor()).toBe(0)
    await other.setPullCursor(9)
    expect(await repo.getPullCursor()).toBe(5)
  })

  it("resolves the device id once and reuses it", async () => {
    expect(await repo.getDeviceId()).toBe("device-1")
    await repo.setPullCursor(1)
    await repo.getPullCursor()
    await repo.getDeviceId()

    expect(deviceIdReads).toBe(1)
  })
})

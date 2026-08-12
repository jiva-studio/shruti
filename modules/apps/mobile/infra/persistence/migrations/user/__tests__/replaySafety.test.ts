import { describe, expect, it } from "vitest"

import type { IDatabase } from "@ports/app/index.js"
import { createInMemoryTestDatabase } from "../../../../repositories/sql/__tests__/testDb.js"
import { userMigrations } from "../index.js"
import { runUserMigrations } from "../runMigrations.js"

/**
 * Every user migration has to survive being applied twice.
 *
 * The engine records a migration as applied only after its `up` commits, so on
 * the native adapter a process kill — or a failing bookkeeping INSERT — between
 * a durable DDL commit and the `migrations` row leaves the change made and the
 * migration unrecorded. The next launch replays it. That is the exact window
 * `columns.ts` was written for.
 *
 * What makes a replay expensive rather than merely ugly: `runMigrations` walks
 * the list in order and does not catch, so the FIRST throw ends the run. Every
 * later migration stays unapplied, and because the failure reproduces
 * identically on every launch, it stays unapplied forever — `no such table` on
 * every personal-library read, a failing `journal()` INSERT behind every note,
 * playlist and chat write. The abort semantics are pinned below so nobody
 * "fixes" this by making one migration's failure quietly skippable.
 */
describe("user migrations — replay safety", () => {
  it("applies the whole ordered list to a fresh database", async () => {
    const db = await createInMemoryTestDatabase()
    await expect(runUserMigrations(db)).resolves.toBeUndefined()

    const applied = await db.query<{ name: string }>("SELECT name FROM migrations")
    expect(applied.map((r) => r.name).sort()).toEqual(userMigrations.map((m) => m.name).sort())
  })

  it("replays every migration as a no-op against the migrated schema", async () => {
    const db = await createInMemoryTestDatabase()
    await runUserMigrations(db)

    // Call `up` directly, bypassing the applied-set: this is the interrupted
    // launch, where the DDL committed but the `migrations` row never landed.
    const threw: string[] = []
    for (const migration of userMigrations) {
      try {
        await migration.up(db)
      } catch (err) {
        threw.push(`${migration.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    expect(threw).toEqual([])
  })

  it("is a no-op across a second launch", async () => {
    const db = await createInMemoryTestDatabase()
    await runUserMigrations(db)
    await expect(runUserMigrations(db)).resolves.toBeUndefined()

    const applied = await db.query<{ name: string }>("SELECT name FROM migrations")
    expect(applied).toHaveLength(userMigrations.length)
  })

  it("stops the whole ordered list at the first throw", async () => {
    const db = await createInMemoryTestDatabase()
    const ran: string[] = []
    const list = [
      userMigrations[0]!,
      { name: "x_ok", up: async () => void ran.push("x_ok") },
      {
        name: "x_boom",
        up: async () => {
          ran.push("x_boom")
          throw new Error("duplicate column name: references_json")
        },
      },
      { name: "x_never", up: async () => void ran.push("x_never") },
    ]

    await expect(runMigrationsFrom(db, list)).rejects.toThrow(/duplicate column name/)
    expect(ran).toEqual(["x_ok", "x_boom"])

    // …and it stays unapplied on the next launch, because the throw is
    // deterministic. This is the "forever" in the issue.
    await expect(runMigrationsFrom(db, list)).rejects.toThrow(/duplicate column name/)
    const applied = await db.query<{ name: string }>("SELECT name FROM migrations")
    expect(applied.map((r) => r.name)).not.toContain("x_never")
  })
})

/** Thin indirection so the abort-semantics test uses the same engine the app
 *  does, without exporting a second runner from production code. */
async function runMigrationsFrom(
  db: IDatabase,
  list: readonly { name: string; up: (db: IDatabase) => Promise<void> }[]
): Promise<void> {
  const { runMigrations } = await import("@kit/persistence")
  await runMigrations(db, list)
}

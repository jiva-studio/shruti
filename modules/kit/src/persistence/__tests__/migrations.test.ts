import { describe, it, expect } from "vitest"
import { runMigrations, type Migration } from "../migrations.js"
import type { IDatabase, QueryParams } from "../database.js"

/** In-memory IDatabase that models just the `migrations` table the runner touches. */
class FakeDb implements IDatabase {
  applied: string[] = []
  upCalls: string[] = []
  saved = 0

  async query<T = unknown>(q: string): Promise<T[]> {
    if (q.includes("SELECT name FROM migrations")) {
      return this.applied.map((name) => ({ name })) as T[]
    }
    return [] as T[]
  }
  async execute(stmt: string, params?: QueryParams): Promise<void> {
    if (stmt.startsWith("INSERT INTO migrations")) {
      this.applied.push(String(params?.[0]))
    }
  }
  async transaction(fn: () => Promise<void>): Promise<void> {
    await fn()
  }
  async save(): Promise<void> {
    this.saved++
  }
  async close(): Promise<void> {}
}

const mk = (name: string): Migration => ({
  name,
  up: async (db) => {
    ;(db as FakeDb).upCalls.push(name)
  },
})

describe("runMigrations", () => {
  it("no-ops on an empty migration list", async () => {
    const db = new FakeDb()
    await runMigrations(db, [])
    expect(db.applied).toEqual([])
    expect(db.saved).toBe(0)
  })

  it("applies all migrations once, in order, on a fresh db", async () => {
    const db = new FakeDb()
    await runMigrations(db, [mk("000_init"), mk("001_a"), mk("002_b")])
    expect(db.applied).toEqual(["000_init", "001_a", "002_b"])
    expect(db.saved).toBe(1)
  })

  it("is idempotent — a second run applies nothing new", async () => {
    const db = new FakeDb()
    const migs = [mk("000_init"), mk("001_a")]
    await runMigrations(db, migs)
    db.upCalls.length = 0
    await runMigrations(db, migs)
    expect(db.applied).toEqual(["000_init", "001_a"]) // no duplicates
    // Only the unconditional first-migration up runs on the second pass.
    expect(db.upCalls).toEqual(["000_init"])
  })

  it("applies only the pending tail when some are already applied", async () => {
    const db = new FakeDb()
    db.applied = ["000_init", "001_a"] // pretend these already ran
    await runMigrations(db, [mk("000_init"), mk("001_a"), mk("002_b"), mk("003_c")])
    expect(db.applied).toEqual(["000_init", "001_a", "002_b", "003_c"])
  })

  it("applies each migration's up + bookkeeping inside one transaction", async () => {
    // A transaction-aware fake: records ordering and only commits the INSERT
    // when its enclosing transaction resolves, mirroring native autocommit
    // being suppressed inside db.transaction().
    class TxDb extends FakeDb {
      events: string[] = []
      private pendingInsert: string | null = null

      override async execute(stmt: string, params?: QueryParams): Promise<void> {
        if (stmt.startsWith("INSERT INTO migrations")) {
          this.events.push(`insert:${String(params?.[0])}`)
          this.pendingInsert = String(params?.[0])
          return
        }
        await super.execute(stmt, params)
      }
      override async transaction(fn: () => Promise<void>): Promise<void> {
        this.events.push("tx:begin")
        try {
          await fn()
          if (this.pendingInsert !== null) this.applied.push(this.pendingInsert)
          this.events.push("tx:commit")
        } catch (e) {
          this.events.push("tx:rollback")
          throw e
        } finally {
          this.pendingInsert = null
        }
      }
    }

    const db = new TxDb()
    const tracking: Migration = {
      name: "001_a",
      up: async (d) => {
        ;(d as TxDb).events.push("up:001_a")
      },
    }
    await runMigrations(db, [mk("000_init"), tracking])

    // Each pending migration's up + bookkeeping insert is wrapped in one
    // committed transaction (begin → up → insert → commit). 000_init also
    // re-runs unconditionally once before the loop, outside any transaction.
    expect(db.events).toEqual([
      "tx:begin",
      "insert:000_init",
      "tx:commit",
      "tx:begin",
      "up:001_a",
      "insert:001_a",
      "tx:commit",
    ])
    expect(db.applied).toEqual(["000_init", "001_a"])
  })

  it("rolls back and does not record a migration whose up() throws", async () => {
    const recorded: string[] = []
    const db: IDatabase = {
      async query<T = unknown>(q: string): Promise<T[]> {
        return (q.includes("SELECT name FROM migrations") ? [] : []) as T[]
      },
      async execute(stmt: string, params?: QueryParams): Promise<void> {
        if (stmt.startsWith("INSERT INTO migrations")) recorded.push(String(params?.[0]))
      },
      async transaction(fn: () => Promise<void>): Promise<void> {
        // Real transactions roll back on throw — propagate so nothing lands.
        await fn()
      },
      async save(): Promise<void> {},
      async close(): Promise<void> {},
    }

    const init: Migration = { name: "000_init", up: async () => {} }
    const boom: Migration = {
      name: "001_bad",
      up: async () => {
        throw new Error("boom")
      },
    }

    await expect(runMigrations(db, [init, boom])).rejects.toThrow("boom")
    // The failing migration's INSERT is never reached (up() threw first), so it
    // stays unrecorded and is retried (not skipped) on the next launch.
    expect(recorded).not.toContain("001_bad")
  })
})

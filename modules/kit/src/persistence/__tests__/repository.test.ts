import { describe, it, expect } from "vitest"
import { queryOne, queryMany, mutate, runInTransaction, SqlRepository } from "../repository.js"
import type { IDatabase, QueryParams } from "../database.js"

interface ExecuteCall {
  sql: string
  params?: QueryParams
}

/**
 * Records every interaction and returns canned rows for `query`. Lets the
 * tests assert exact SQL / params passthrough and call ordering.
 */
class FakeDb implements IDatabase {
  rows: unknown[] = []
  queryCalls: ExecuteCall[] = []
  executeCalls: ExecuteCall[] = []
  saved = 0
  transactions = 0
  closed = 0
  /** Records the ordering of save() vs execute() to prove mutate() flushes after writing. */
  order: string[] = []

  async query<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
    this.queryCalls.push({ sql, params })
    return this.rows as T[]
  }
  async execute(sql: string, params?: QueryParams): Promise<void> {
    this.executeCalls.push({ sql, params })
    this.order.push("execute")
  }
  async transaction(fn: () => Promise<void>): Promise<void> {
    this.transactions++
    await fn()
  }
  async save(): Promise<void> {
    this.saved++
    this.order.push("save")
  }
  async close(): Promise<void> {
    this.closed++
  }
}

describe("queryOne", () => {
  it("returns null when the query yields no rows", async () => {
    const db = new FakeDb()
    db.rows = []
    const result = await queryOne(db, "SELECT * FROM t WHERE id = ?", ["x"], () => {
      throw new Error("mapper must not be called on empty result")
    })
    expect(result).toBeNull()
    expect(db.queryCalls).toEqual([{ sql: "SELECT * FROM t WHERE id = ?", params: ["x"] }])
  })

  it("maps the first row when present", async () => {
    const db = new FakeDb()
    db.rows = [{ id: 1 }, { id: 2 }]
    const result = await queryOne<{ id: number }, string>(
      db,
      "SELECT * FROM t",
      [],
      (row) => `row-${row.id}`
    )
    expect(result).toBe("row-1")
  })
})

describe("queryMany", () => {
  it("maps each row in order", async () => {
    const db = new FakeDb()
    db.rows = [{ n: 1 }, { n: 2 }, { n: 3 }]
    const result = await queryMany<{ n: number }, number>(
      db,
      "SELECT n FROM t",
      [],
      (row) => row.n * 10
    )
    expect(result).toEqual([10, 20, 30])
  })

  it("returns an empty array for no rows", async () => {
    const db = new FakeDb()
    db.rows = []
    const result = await queryMany(db, "SELECT * FROM t", [], () => 1)
    expect(result).toEqual([])
  })
})

describe("mutate", () => {
  it("passes the statement and params through and saves after executing", async () => {
    const db = new FakeDb()
    await mutate(db, "DELETE FROM t WHERE id = ?", ["x"])
    expect(db.executeCalls).toEqual([{ sql: "DELETE FROM t WHERE id = ?", params: ["x"] }])
    expect(db.saved).toBe(1)
    expect(db.order).toEqual(["execute", "save"])
  })

  it("works without params", async () => {
    const db = new FakeDb()
    await mutate(db, "DELETE FROM t")
    expect(db.executeCalls).toEqual([{ sql: "DELETE FROM t", params: undefined }])
    expect(db.saved).toBe(1)
  })
})

describe("runInTransaction", () => {
  it("runs fn inside a transaction and returns its value", async () => {
    const db = new FakeDb()
    const result = await runInTransaction(db, async () => {
      await db.execute("INSERT INTO t VALUES (1)")
      return 42
    })
    expect(result).toBe(42)
    expect(db.transactions).toBe(1)
    expect(db.executeCalls).toHaveLength(1)
  })

  it("propagates errors thrown inside the callback", async () => {
    const db = new FakeDb()
    await expect(
      runInTransaction(db, async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
  })
})

describe("SqlRepository", () => {
  it("exposes the helpers bound to a single database", async () => {
    const db = new FakeDb()
    db.rows = [{ id: 7 }]

    class Repo extends SqlRepository {
      getOne() {
        return this.queryOne<{ id: number }, number>("SELECT id FROM t", [], (r) => r.id)
      }
      getMany() {
        return this.queryMany<{ id: number }, number>("SELECT id FROM t", [], (r) => r.id)
      }
      remove() {
        return this.mutate("DELETE FROM t WHERE id = ?", [7])
      }
      tx() {
        return this.runInTransaction(async () => "ok")
      }
    }

    const repo = new Repo(db)
    expect(await repo.getOne()).toBe(7)
    expect(await repo.getMany()).toEqual([7])
    await repo.remove()
    expect(db.executeCalls.at(-1)).toEqual({ sql: "DELETE FROM t WHERE id = ?", params: [7] })
    expect(db.saved).toBe(1)
    expect(await repo.tx()).toBe("ok")
    expect(db.transactions).toBe(1)
  })
})

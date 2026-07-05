import { describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createReentrantUnitOfWork } from "../reentrantUnitOfWork.sql.js"

/** Fake db recording BEGIN/COMMIT so we can assert how many real transactions
 *  were opened. `transaction()` serialises callers through a promise chain and
 *  rejects a nested BEGIN — mirroring the real SQLite adapters. */
function makeFakeDb() {
  const events: string[] = []
  let inTx = false
  let queue: Promise<unknown> = Promise.resolve()
  const db: IDatabase = {
    async query<T>(): Promise<T[]> {
      return [] as T[]
    },
    async execute(sql: string): Promise<void> {
      events.push(`exec:${sql}`)
    },
    transaction(fn: () => Promise<void>): Promise<void> {
      const next = queue.then(async () => {
        if (inTx) throw new Error("cannot start a transaction within a transaction")
        inTx = true
        events.push("BEGIN")
        try {
          await fn()
          events.push("COMMIT")
        } catch (e) {
          events.push("ROLLBACK")
          throw e
        } finally {
          inTx = false
        }
      })
      queue = next.then(
        () => undefined,
        () => undefined
      )
      return next
    },
    async save(): Promise<void> {},
    async close(): Promise<void> {},
  }
  return { db, events }
}

describe("createReentrantUnitOfWork", () => {
  it("opens exactly one transaction for a standalone run", async () => {
    const { db, events } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)
    await uow.run(async () => {
      await db.execute("write-1")
    })
    expect(events).toEqual(["BEGIN", "exec:write-1", "COMMIT"])
  })

  it("joins the outer transaction on a nested run (no second BEGIN, no deadlock)", async () => {
    const { db, events } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)
    const result = await uow.run(async () => {
      await db.execute("outer")
      // A decorator journaling inside the caller's transaction:
      const inner = await uow.run(async () => {
        await db.execute("journal")
        return "joined"
      })
      return inner
    })
    expect(result).toBe("joined")
    // One transaction wrapping both writes.
    expect(events).toEqual(["BEGIN", "exec:outer", "exec:journal", "COMMIT"])
  })

  it("returns the callback's value", async () => {
    const { db } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)
    await expect(uow.run(async () => 42)).resolves.toBe(42)
  })

  it("rolls back and propagates the original error", async () => {
    const { db, events } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)
    await expect(
      uow.run(async () => {
        await db.execute("write")
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    expect(events).toEqual(["BEGIN", "exec:write", "ROLLBACK"])
  })

  it("serialises independent top-level runs into separate transactions", async () => {
    const { db, events } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)
    await Promise.all([
      uow.run(async () => {
        await db.execute("a")
      }),
      uow.run(async () => {
        await db.execute("b")
      }),
    ])
    // Two distinct transactions, never interleaved.
    expect(events).toEqual(["BEGIN", "exec:a", "COMMIT", "BEGIN", "exec:b", "COMMIT"])
  })
})

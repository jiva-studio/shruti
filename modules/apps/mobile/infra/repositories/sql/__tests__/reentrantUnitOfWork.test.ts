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

/** Drops the savepoint bookkeeping so an assertion can talk about the writes
 *  a joined block performed without pinning the generated savepoint names. */
function withoutSavepoints(events: readonly string[]): string[] {
  return events.filter((e) => !/^exec:(SAVEPOINT|RELEASE|ROLLBACK TO) /.test(e))
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

  it("joins the outer transaction on a nested run carrying its handle", async () => {
    const { db, events } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)
    const result = await uow.run(async (tx) => {
      await db.execute("outer")
      // A decorator journaling inside the caller's transaction — it is handed
      // the caller's transaction handle, which is what marks it as nested.
      const inner = await uow.run(async () => {
        await db.execute("journal")
        return "joined"
      }, tx)
      return inner
    })
    expect(result).toBe("joined")
    // One transaction wrapping both writes.
    expect(withoutSavepoints(events)).toEqual(["BEGIN", "exec:outer", "exec:journal", "COMMIT"])
    // …and the joined block is bracketed by a savepoint.
    expect(events.filter((e) => e.startsWith("exec:SAVEPOINT"))).toHaveLength(1)
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

  it("gives a run from an unrelated stack its own transaction, kept out of the in-flight one", async () => {
    // THE regression test for #1493. A sync pull holds one transaction across
    // a whole page of `applyRemote` awaits (`backfillLocal` holds one across
    // the entire first-sign-in walk) and then fails. Meanwhile an unrelated
    // subscriber — one of the eight that fire on a single `appStateChange` —
    // issues its own `run`. It carries no handle, so it is not nested, and its
    // write must not be spliced into the pull's transaction and lost with it.
    const { db, events } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)

    let open!: () => void
    let release!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))

    const pull = uow.run(async () => {
      await db.execute("applyRemote-1")
      open()
      await gate
      await db.execute("applyRemote-2")
      throw new Error("pull failed")
    })
    await opened

    const foreign = uow.run(async () => {
      await db.execute("session-finish")
    })
    // Let the foreign run get as far as it can while the pull is still open.
    await Promise.resolve()
    release()

    await expect(pull).rejects.toThrow("pull failed")
    await foreign

    expect(events).toEqual([
      "BEGIN",
      "exec:applyRemote-1",
      "exec:applyRemote-2",
      "ROLLBACK",
      "BEGIN",
      "exec:session-finish",
      "COMMIT",
    ])
  })

  it("does not join a handle whose transaction has already finished", async () => {
    const { db, events } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)

    let stale: unknown
    await uow.run(async (tx) => {
      stale = tx
      await db.execute("first")
    })

    // A stashed handle is not a licence to write into whatever is open now.
    await uow.run(async () => {
      await db.execute("later")
    }, stale as never)

    expect(events).toEqual(["BEGIN", "exec:first", "COMMIT", "BEGIN", "exec:later", "COMMIT"])
  })

  it("rolls a failed joined block back to its savepoint instead of committing it", async () => {
    // #1493's second harm mode: a joined run that threw used to leave its
    // partial writes behind, committed with the outer transaction.
    const { db, events } = makeFakeDb()
    const uow = createReentrantUnitOfWork(db)

    await uow.run(async (tx) => {
      await db.execute("domain-write")
      await expect(
        uow.run(async () => {
          await db.execute("half-journal")
          throw new Error("journal failed")
        }, tx)
      ).rejects.toThrow("journal failed")
    })

    const savepoint = events
      .find((e) => e.startsWith("exec:SAVEPOINT "))!
      .slice("exec:SAVEPOINT ".length)
    expect(events).toEqual([
      "BEGIN",
      "exec:domain-write",
      `exec:SAVEPOINT ${savepoint}`,
      "exec:half-journal",
      `exec:ROLLBACK TO ${savepoint}`,
      `exec:RELEASE ${savepoint}`,
      "COMMIT",
    ])
  })
})

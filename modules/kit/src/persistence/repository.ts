import type { IDatabase, QueryParams } from "./database.js"

/**
 * Maps a single raw SQL result row to a domain value. Kept here only as a
 * shared signature — the app owns the mapper bodies (they know the column
 * shapes and domain types). kit never sees a table name or column.
 */
export type RowMapper<R, T> = (row: R) => T

/**
 * Generic, framework-free scaffolding for SQL-backed repositories on top of
 * {@link IDatabase}. These helpers replace the repeated
 * query → check → map → (save) boilerplate that every app repository grows:
 * the SQL strings and row mappers stay app-side; kit only owns the plumbing.
 *
 * Two equivalent shapes are offered:
 *  - standalone functions ({@link queryOne}, {@link queryMany}, {@link mutate},
 *    {@link runInTransaction}) for the common factory-function repositories, and
 *  - a {@link SqlRepository} thin wrapper that binds a single `IDatabase` once
 *    so a repository body can call `this.queryOne(...)` without re-passing `db`.
 *
 * Error handling is deliberately a passthrough: any error thrown by the
 * underlying `IDatabase` propagates unchanged, exactly as the hand-written
 * repositories behaved.
 */

/**
 * Runs a read query and maps the first row, or returns `null` when the query
 * yields no rows. Mirrors the ubiquitous
 * `const rows = await db.query(...); return rows[0] ? map(rows[0]) : null`.
 */
export async function queryOne<R, T>(
  db: IDatabase,
  sql: string,
  params: QueryParams,
  map: RowMapper<R, T>
): Promise<T | null> {
  const rows = await db.query<R>(sql, params)
  return rows.length > 0 ? map(rows[0]!) : null
}

/**
 * Runs a read query and maps every row. Mirrors
 * `const rows = await db.query(...); return rows.map(map)`.
 */
export async function queryMany<R, T>(
  db: IDatabase,
  sql: string,
  params: QueryParams,
  map: RowMapper<R, T>
): Promise<T[]> {
  const rows = await db.query<R>(sql, params)
  return rows.map(map)
}

/**
 * Executes a write statement and flushes it to storage. Mirrors the common
 * `await db.execute(...); await db.save()` pairing. Use the raw
 * `db.execute`/`db.save` directly when several writes should share one
 * `save()` (e.g. inside a transaction).
 */
export async function mutate(db: IDatabase, sql: string, params?: QueryParams): Promise<void> {
  await db.execute(sql, params)
  await db.save()
}

/**
 * Runs `fn` inside `db.transaction` and returns its result. The underlying
 * transaction commits on resolve and rolls back on throw; the resolved value
 * of `fn` is surfaced to the caller. Mirrors the unit-of-work pattern.
 */
export async function runInTransaction<T>(db: IDatabase, fn: () => Promise<T>): Promise<T> {
  let captured: T
  await db.transaction(async () => {
    captured = await fn()
  })
  // db.transaction resolves only after COMMIT, so captured is assigned.
  return captured!
}

/**
 * Optional thin base that binds one {@link IDatabase} so repository methods can
 * call `this.queryOne(...)` / `this.mutate(...)` without threading `db` through
 * every call. Purely a convenience over the standalone helpers above — it adds
 * no behavior of its own and bakes in no domain knowledge.
 */
export class SqlRepository {
  protected readonly db: IDatabase

  constructor(db: IDatabase) {
    this.db = db
  }

  /** See {@link queryOne}. */
  protected queryOne<R, T>(
    sql: string,
    params: QueryParams,
    map: RowMapper<R, T>
  ): Promise<T | null> {
    return queryOne(this.db, sql, params, map)
  }

  /** See {@link queryMany}. */
  protected queryMany<R, T>(sql: string, params: QueryParams, map: RowMapper<R, T>): Promise<T[]> {
    return queryMany(this.db, sql, params, map)
  }

  /** See {@link mutate}. */
  protected mutate(sql: string, params?: QueryParams): Promise<void> {
    return mutate(this.db, sql, params)
  }

  /** See {@link runInTransaction}. */
  protected runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return runInTransaction(this.db, fn)
  }
}

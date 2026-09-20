// kit/persistence — generic user-DB engine (declare schema + migrations, reuse).
export type { QueryValue, QueryParams, Row, IDatabase, IPersistence } from "./database.js"
export { type Migration, runMigrations } from "./migrations.js"
export { isSqliteFile, replaceDatabaseContents } from "./transfer.js"
export {
  type RowMapper,
  queryOne,
  queryMany,
  mutate,
  runInTransaction,
  SqlRepository,
} from "./repository.js"

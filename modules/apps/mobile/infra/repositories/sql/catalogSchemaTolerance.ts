/**
 * A freshly-shipped binary can run against an older bundled catalog database.
 * These two predicates let a read degrade to "nothing here" instead of
 * throwing when the table or column it wants has not shipped yet; any other
 * SQL error is rethrown so real bugs surface.
 */

/**
 * SQLite returns `no such table: <name>` when a query hits a table that
 * hasn't been created. We surface that as "no collections" so the mobile
 * binary can ship ahead of the catalog schema.
 *
 * Both `sql.js` (web) and `@capacitor-community/sqlite` (native) include the
 * table name in the message, so a substring match is sufficient.
 */
export function isMissingTable(err: unknown): boolean {
  if (!err) return false
  const message = err instanceof Error ? err.message : String(err)
  return /no such table:\s*(collections|collection_tracks|collection_tags|collection_groups|collection_group_items)\b/i.test(
    message
  )
}

/**
 * SQLite reports `no such column: <name>` when a query reads a column an
 * older catalog DB doesn't have yet (e.g. authors.image / authors.description
 * before the author-profile migration). Lets reads degrade gracefully on a
 * stale bundled DB.
 */
export function isMissingColumn(err: unknown): boolean {
  if (!err) return false
  const message = err instanceof Error ? err.message : String(err)
  return /no such column:/i.test(message)
}

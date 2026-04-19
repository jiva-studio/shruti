/**
 * Reads the scheme version of an open content database. Implementations
 * consult the DB's `migrations` table and return `0` when the DB predates
 * the scheme concept.
 */
export interface ISchemeVersionRepository {
  read(): Promise<number>
}

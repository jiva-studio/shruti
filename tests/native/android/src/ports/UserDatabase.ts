/** The app's SQLite user database as it sits on the device's own disk. */
export interface UserDatabase {
  /** Put a database file in place of the app's own, before the app opens it. */
  install(localFile: string): Promise<void>
  /** Names recorded in the `migrations` table — what the app believes it applied. */
  appliedMigrations(): Promise<string[]>
  tables(): Promise<string[]>
  columnsOf(table: string): Promise<string[]>
  indexes(): Promise<string[]>
  rows(table: string, columns: readonly string[]): Promise<Record<string, unknown>[]>
}

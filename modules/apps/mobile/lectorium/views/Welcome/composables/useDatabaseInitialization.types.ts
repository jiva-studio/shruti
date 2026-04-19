import type { Ref } from "vue"
import type { IDatabaseFetcher } from "@ports/app/index.js"

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

export type DatabaseInitializationState = "checking" | "downloading" | "error" | "complete"

export interface UseDatabaseInitializationOptions {
  /**
   * Database fetcher instance for checking and downloading the database
   */
  fetcher: IDatabaseFetcher

  /**
   * URL of the database to download
   */
  databaseUrl: string

  /**
   * Database path in format "dbName/storeName/key"
   */
  databasePath: string

  /**
   * Callback when database initialization completes successfully
   */
  onComplete?: () => void

  /**
   * Callback when an error occurs during initialization
   */
  onError?: (error: string) => void
}

export interface UseDatabaseInitializationReturn {
  /**
   * Current state of the database initialization process
   */
  state: Ref<DatabaseInitializationState>

  /**
   * Error message if initialization failed
   */
  error: Ref<string | null>

  /**
   * Download progress (0-100)
   */
  progress: Ref<number>

  /**
   * Whether the database is currently being downloaded
   */
  isDownloading: Ref<boolean>

  /**
   * Initialize the database (check existence and download if needed)
   */
  initialize: () => Promise<void>

  /**
   * Retry initialization after an error
   */
  retry: () => Promise<void>
}

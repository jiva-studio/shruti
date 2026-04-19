import { ref } from "vue"
import type {
  DatabaseInitializationState,
  UseDatabaseInitializationOptions,
  UseDatabaseInitializationReturn,
} from "./useDatabaseInitialization.types.js"

export type {
  DatabaseInitializationState,
  UseDatabaseInitializationOptions,
  UseDatabaseInitializationReturn,
}

/* -------------------------------------------------------------------------- */
/*                            Composable Function                             */
/* -------------------------------------------------------------------------- */

export function useDatabaseInitialization(
  options: UseDatabaseInitializationOptions
): UseDatabaseInitializationReturn {
  const { fetcher, databaseUrl, databasePath, onComplete, onError } = options

  /* ------------------------------ State ------------------------------ */

  const state = ref<DatabaseInitializationState>("checking")
  const error = ref<string | null>(null)
  const progress = ref<number>(0)
  const isDownloading = ref<boolean>(false)

  /* ------------------------------ Actions ------------------------------ */

  /**
   * Initialize the database check and download process
   */
  async function initialize(): Promise<void> {
    try {
      state.value = "checking"
      error.value = null
      progress.value = 0

      // Check if database already exists
      const dbExists = await fetcher.exists(databasePath)
      if (dbExists) {
        state.value = "complete"
        onComplete?.()
        return
      }

      // Database doesn't exist, start download
      state.value = "downloading"
      await fetcher.download(
        databaseUrl,
        databasePath,
        (receivedLength, totalLength, downloading) => {
          progress.value = totalLength > 0 ? Math.round((receivedLength / totalLength) * 100) : 0
          isDownloading.value = downloading
        }
      )

      // Download complete
      state.value = "complete"
      onComplete?.()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to download database"
      state.value = "error"
      error.value = errorMessage
      onError?.(errorMessage)
      console.error("Database initialization error:", err)
    }
  }

  /**
   * Retry initialization after an error
   */
  async function retry(): Promise<void> {
    await initialize()
  }

  /* ------------------------------ Return ------------------------------ */

  return {
    state,
    error,
    progress,
    isDownloading,
    initialize,
    retry,
  }
}

import { useShruti } from "@shruti/shruti.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"

/**
 * Re-runs a failed personal-library ingest. A dead-lettered item is re-added by
 * its `sourceUrl` through the same add-to-library chat transport a fresh add
 * uses; the orchestrator maps the re-add to the SAME job and restarts it in
 * place, so the card recovers (failed → processing → ready) without a duplicate
 * row. An item with no `sourceUrl` (older rows) can't be retried and is a no-op.
 * Shared by the "My library" shelf and the full library view so the retry
 * wiring lives in one place.
 */
export function useRetryLibraryItem(): (item: LibraryItem) => void {
  const app = useShruti()
  const chat = useChatStore()
  return function retryLibraryItem(item: LibraryItem): void {
    if (!item.sourceUrl) return
    void app.haptics.impact("light")
    void chat.sendAddToLibrary(item.sourceUrl)
  }
}

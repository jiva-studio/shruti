import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import { useShruti } from "@shruti/shruti.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"

/**
 * Re-runs a failed personal-library ingest. A dead-lettered item is re-added by
 * its `sourceUrl` through the orchestrator ingest API (the single client→server
 * path — chat never ingests); the orchestrator maps the re-add to the SAME job
 * and restarts it in place, so the card recovers (failed → processing → ready)
 * without a duplicate row. An item with no `sourceUrl` (older rows) can't be
 * retried and is a no-op. Shared by the "My library" shelf and the full library
 * view so the retry wiring lives in one place.
 *
 * A re-submit that is itself rejected is toasted: the user is already in the
 * failure path, the tile keeps the very badge it had, and without a word from
 * the tap "Retry" is indistinguishable from a button that does nothing (#1778).
 */
export function useRetryLibraryItem(): (item: LibraryItem) => void {
  const { t } = useI18n()
  const app = useShruti()
  const library = useLibraryStore()
  const toast = useToast()

  async function resubmit(item: LibraryItem, sourceUrl: string): Promise<void> {
    const result = await library.addByUrl(sourceUrl, {
      title: item.titleRaw ?? undefined,
      author: item.authorRaw ?? undefined,
    })
    // `paywalled` already put the subscription page on screen.
    if (result === "failed") await toast.error(t("library.addError"))
  }

  return function retryLibraryItem(item: LibraryItem): void {
    if (!item.sourceUrl) return
    void app.haptics.impact("light")
    void resubmit(item, item.sourceUrl)
  }
}

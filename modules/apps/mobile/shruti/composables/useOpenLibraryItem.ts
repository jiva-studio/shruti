import { useShruti } from "@shruti/shruti.js"
import { useTrackActionSheet } from "@shruti/composables/useTrackActionSheet.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"

/**
 * Opens a personal-library item through the same track surface a corpus lecture
 * uses (a ready item's content-addressed track resolves via the composite repo).
 * A not-yet-ready item has no track_id and is a no-op. Shared by the "My
 * library" shelf and the full library view so the play-surface wiring lives in
 * one place.
 */
export function useOpenLibraryItem(): (item: LibraryItem) => void {
  const app = useShruti()
  const trackActions = useTrackActionSheet()
  return function openLibraryItem(item: LibraryItem): void {
    if (!item.trackId) return
    void app.haptics.impact("light")
    void trackActions.present(item.trackId as TrackId)
  }
}

import type { TrackId } from "@lib/domain/core.js"
import { useTrackSheetStore } from "@shruti/stores/useTrackSheetStore.js"

export interface UseTrackActionSheetReturn {
  present: (trackId: TrackId) => Promise<void>
}

/**
 * Opens the per-track detail bottom sheet (`<TrackSheet>`, mounted at the app
 * root) for the Search / Collection call sites via `present(trackId)`. The
 * actual content — lecture title, description, chapter outline,
 * add-to-playlist, share — lives in `TrackSheet.vue`, driven by
 * `useTrackSheetStore`. Opening the transcript is not offered here: the
 * FloatingPlayer / transcript reader own that flow.
 */
export function useTrackActionSheet(): UseTrackActionSheetReturn {
  const sheet = useTrackSheetStore()

  function present(trackId: TrackId): Promise<void> {
    sheet.open(trackId)
    return Promise.resolve()
  }

  return { present }
}

import type { TrackId } from "@lib/domain/core.js"
import { useTrackSheetStore } from "@lectorium/stores/useTrackSheetStore.js"

export interface UseTrackActionSheetReturn {
  present: (trackId: TrackId) => Promise<void>
}

/**
 * Opens the per-track detail bottom sheet (`<TrackSheet>`, mounted at the app
 * root). Kept as a composable with the original `present(trackId)` signature so
 * the Search / Collection call sites stay unchanged; the actual content —
 * lecture title, description, chapter outline, add-to-playlist, share — lives in
 * `TrackSheet.vue`, driven by `useTrackSheetStore`. Replaces the old imperative
 * Ionic action sheet (whose "Open transcript" button is dropped — the
 * FloatingPlayer / transcript reader own that flow now).
 */
export function useTrackActionSheet(): UseTrackActionSheetReturn {
  const sheet = useTrackSheetStore()

  function present(trackId: TrackId): Promise<void> {
    sheet.open(trackId)
    return Promise.resolve()
  }

  return { present }
}

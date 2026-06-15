import { defineStore } from "pinia"
import { ref } from "vue"
import type { TrackId } from "@lib/domain/core.js"

/**
 * Which track's detail bottom-sheet is currently open. The `<TrackSheet>`
 * mounted at the app root reads this and loads the track; the imperative
 * `useTrackActionSheet().present()` sets it. One global sheet — imperative
 * entry point, declarative render — so Search / Collection / chat all open the
 * same unified dialog.
 */
export const useTrackSheetStore = defineStore("trackSheet", () => {
  const trackId = ref<TrackId | null>(null)

  function open(id: TrackId): void {
    trackId.value = id
  }

  function close(): void {
    trackId.value = null
  }

  return { trackId, open, close }
})

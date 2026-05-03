import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { TrackId } from "@lib/domain/core.js"

/**
 * Drives the TranscriptDialog modal. Separate from usePlayerStore because
 * the transcript can be opened without audio playing (a user tapping the
 * floating player, or a direct deep-link to a transcript-only lecture).
 */
export const useTranscriptStore = defineStore("transcript", () => {
  const trackId = ref<TrackId | null>(null)

  const open = computed(() => trackId.value !== null)

  function show(id: TrackId): void {
    trackId.value = id
  }

  function close(): void {
    trackId.value = null
  }

  return { trackId, open, show, close }
})

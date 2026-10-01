import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { DiscoveryHit } from "@lib/contracts"

/**
 * Bottom-sheet modal state for an external discovered lecture.
 * Reads a single DiscoveryHit and exposes open/close actions.
 */
export const useWebTrackSheetStore = defineStore("webTrackSheet", () => {
  const hit = ref<DiscoveryHit | null>(null)

  const isOpen = computed(() => hit.value !== null)

  function open(nextHit: DiscoveryHit): void {
    hit.value = nextHit
  }

  function close(): void {
    hit.value = null
  }

  return { hit, isOpen, open, close }
})

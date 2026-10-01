import { defineStore } from "pinia"
import { ref } from "vue"
import type { DiscoveryHit } from "@lib/contracts"
import { useOverlaysStore } from "./useOverlaysStore.js"

/**
 * Bottom-sheet modal state for an external discovered lecture.
 * Reads a single DiscoveryHit and exposes open/close actions.
 */
export const useWebTrackSheetStore = defineStore("webTrackSheet", () => {
  const hit = ref<DiscoveryHit | null>(null)
  const isOpen = ref<boolean>(false)
  const overlays = useOverlaysStore()

  function open(nextHit: DiscoveryHit): void {
    hit.value = nextHit
    isOpen.value = true
    overlays.actionSheetOpen = true
  }

  function close(): void {
    isOpen.value = false
    overlays.actionSheetOpen = false
  }

  function onDismiss(): void {
    isOpen.value = false
    hit.value = null
    overlays.actionSheetOpen = false
  }

  return { hit, isOpen, open, close, onDismiss }
})

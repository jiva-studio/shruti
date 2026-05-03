import { defineStore } from "pinia"
import { ref } from "vue"

/**
 * Tracks the global presence of dismissable overlays so root-level
 * chrome — currently the FloatingPlayer — can step out of the way
 * while one is open.
 */
export const useOverlaysStore = defineStore("overlays", () => {
  const actionSheetOpen = ref<boolean>(false)
  return { actionSheetOpen }
})

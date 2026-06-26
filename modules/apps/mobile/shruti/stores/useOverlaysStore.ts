import { defineStore } from "pinia"
import { ref } from "vue"

/**
 * Tracks the global presence of dismissable overlays so root-level
 * chrome — currently the FloatingPlayer — can step out of the way
 * while one is open.
 */
export const useOverlaysStore = defineStore("overlays", () => {
  const actionSheetOpen = ref<boolean>(false)
  // Drives the global email sign-in modal mounted in App.vue. Set true by
  // useAnonymousSignInFlow so any surface (Settings row, chat limit banner)
  // can open the passwordless flow without owning template real estate.
  const emailSignInOpen = ref<boolean>(false)
  return { actionSheetOpen, emailSignInOpen }
})

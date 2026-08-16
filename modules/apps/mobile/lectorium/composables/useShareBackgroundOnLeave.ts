import { watch } from "vue"
import router from "@lectorium/router/index.js"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"

/**
 * Light the background-share indicator when the surface that started a share
 * stops being on screen.
 *
 * The share slot is app-wide and single: while one job holds it, every other
 * share surface refuses with "Another share is already in progress". That
 * refusal is only fair if the user can see what is holding the slot. Notes
 * gets this from its 3-second handoff — it hands the work to the background
 * itself and calls `markInBackground()` on the way out. The surfaces that
 * never block the UI (Studio, whose video render can run for the full 8-minute
 * poll budget, and the chat share-PDF card) had no equivalent: leaving them
 * mid-render left a job with no on-screen trace at all, and the native share
 * sheet later opened over whatever screen the user had moved to (#1886).
 *
 * Navigation is the signal, not an Ionic page hook: `onIonViewWillLeave` fires
 * only on the component IonRouterOutlet holds as the page, so a nested card
 * like the chat PDF row would never receive it. A route change covers both,
 * including a tab switch.
 *
 * Marking is idempotent and only bites while a job is actually running, so
 * registering this on several surfaces at once is harmless. It does not
 * release the slot — every job still owns that in its own `finally`.
 */
export function useShareBackgroundOnLeave(): void {
  const shareJob = useShareJobStore()
  watch(
    () => router.currentRoute.value.fullPath,
    () => {
      if (shareJob.isRunning) shareJob.markInBackground()
    }
  )
}

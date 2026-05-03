import { computed, type ComputedRef } from "vue"
import { toastController } from "@ionic/vue"
import { useDebugStore } from "@lectorium/stores/useDebugStore.js"

export interface UseDebugUnlockTriggerReturn {
  unlocked: ComputedRef<boolean>
  /** Bind to the tap source (e.g. `@click` on a build-info row). */
  onTap: () => Promise<void>
}

/**
 * Thin wrapper around `useDebugStore` that records a tap and surfaces a
 * confirmation toast the moment debug mode unlocks. View code stays free
 * of toast wiring and store imports.
 */
export function useDebugUnlockTrigger(message = "Debug mode enabled"): UseDebugUnlockTriggerReturn {
  const debug = useDebugStore()

  async function onTap(): Promise<void> {
    if (debug.registerUnlockTap()) {
      const toast = await toastController.create({
        message,
        duration: 1500,
        position: "top",
        color: "success",
      })
      await toast.present()
    }
  }

  return {
    unlocked: computed(() => debug.unlocked),
    onTap,
  }
}

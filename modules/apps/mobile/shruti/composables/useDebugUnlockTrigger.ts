import { computed, type ComputedRef } from "vue"
import { useDebugUnlock, useToast } from "@kit/composables"
import { useDebugStore } from "@shruti/stores/useDebugStore.js"

export interface UseDebugUnlockTriggerReturn {
  unlocked: ComputedRef<boolean>
  /** Bind to the tap source (e.g. `@click` on a build-info row). */
  onTap: () => Promise<void>
}

/**
 * App-specific wiring around kit's generic `useDebugUnlock`: records a tap
 * and surfaces a confirmation toast the moment debug mode unlocks. The
 * unlocked flag is persisted (session-scoped) in `useDebugStore`, which is
 * the host that owns it. View code stays free of toast/store plumbing.
 */
export function useDebugUnlockTrigger(message = "Debug mode enabled"): UseDebugUnlockTriggerReturn {
  const debug = useDebugStore()
  const toast = useToast()

  const unlocker = useDebugUnlock({
    initialUnlocked: debug.unlocked,
    onUnlock: () => debug.setUnlocked(true),
  })

  async function onTap(): Promise<void> {
    if (unlocker.registerTap()) {
      await toast.show(message, { durationMs: 1500, position: "top", color: "success" })
    }
  }

  return {
    unlocked: computed(() => unlocker.unlocked.value),
    onTap,
  }
}

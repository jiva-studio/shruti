import { ref } from "vue"
import { defineStore } from "pinia"

export type StudioHandoff =
  | { readonly kind: "note"; readonly noteId: string }
  | {
      readonly kind: "citation"
      readonly trackId: string
      readonly startMs: number
      readonly endMs: number
      readonly caption?: string
    }

/**
 * Single-slot handoff for opening Studio.
 *
 * One Studio route (`/tabs/studio`) serves both modes — opening a saved
 * Note for editing and opening a transient Citation. The payload that
 * tells Studio *what* to load is parked here by the entry point (Notes
 * action sheet, CitationChip action sheet) and the controller consumes
 * it on mount.
 *
 * Why a store instead of route params / history state:
 *   - Ionic's `IonRouterOutlet` runs page transitions through its own
 *     navigation controller, which drops `history.state` in several
 *     cases — notably when navigation fires from an `IonActionSheet`
 *     handler while the sheet is still dismissing.
 *   - Citation payloads (`trackId`, time range, caption) have no
 *     natural URL representation; baking them into the path would just
 *     give us a sentinel route param to special-case.
 *
 * `consume()` is one-shot — calling it returns the payload and empties
 * the slot so a back-nav-then-forward doesn't re-trigger Studio with
 * stale data.
 */
export const useStudioHandoffStore = defineStore("studioHandoff", () => {
  const pending = ref<StudioHandoff | null>(null)

  function setPending(h: StudioHandoff): void {
    pending.value = h
  }

  function consume(): StudioHandoff | null {
    const h = pending.value
    pending.value = null
    return h
  }

  return { pending, setPending, consume }
})

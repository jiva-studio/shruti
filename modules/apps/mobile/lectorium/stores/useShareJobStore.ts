import { computed, ref } from "vue"
import { defineStore } from "pinia"

export type ShareJobKind = "audio" | "video"

export interface ShareJob {
  readonly kind: ShareJobKind
  readonly noteId: string
  readonly startedAt: number
}

/**
 * Single-slot tracker for a long-running share job (cut → render → download).
 *
 * Used by the NotesView controller's `runShareWorkflow` helper to:
 *   1. block concurrent share taps with a "wait" toast (`tryStart` returns
 *      false when the slot is already occupied), and
 *   2. drive the spinner overlay on the Notes tab icon in `TabsLayout.vue`
 *      via the `isRunning` computed.
 *
 * Single slot covers BOTH audio and video. Audio's fast path almost always
 * wins the 3 s handoff and releases the slot before the user can realistically
 * tap a second time, so the cross-kind block rarely surfaces.
 *
 * No persistence: a fresh app launch leaves the slot empty. The server-side
 * render keeps running regardless; the file lands on the CDN and a re-tap
 * after restart is a cache-hit.
 */
export const useShareJobStore = defineStore("shareJob", () => {
  const job = ref<ShareJob | null>(null)
  const isRunning = computed(() => job.value !== null)

  function tryStart(kind: ShareJobKind, noteId: string): boolean {
    if (job.value !== null) return false
    job.value = { kind, noteId, startedAt: Date.now() }
    return true
  }

  function finish(): void {
    job.value = null
  }

  return { job, isRunning, tryStart, finish }
})

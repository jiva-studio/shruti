import { defineStore } from "pinia"
import { computed, ref } from "vue"
import {
  clearLogs,
  logCount,
  logSnapshot,
  subscribeLogs,
  type LogEntry,
} from "@lectorium/services/logger/index.js"

/**
 * Reactive view over the in-memory {@link logSnapshot} ring buffer. The
 * buffer itself is framework-free; this store just bumps a `version` ref on
 * change so Vue re-derives `entries` / `count`.
 *
 * Appends are coalesced to one reactive tick per frame — a burst of console
 * lines (e.g. RC SDK debug output) would otherwise re-render the open log
 * viewer dozens of times in a frame. When the viewer is closed nothing reads
 * `entries`, so the bump is a near-free counter increment.
 */
export const useLogsStore = defineStore("logs", () => {
  const version = ref(0)
  let pending = false

  subscribeLogs(() => {
    if (pending) return
    pending = true
    const flush = (): void => {
      pending = false
      version.value++
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush)
    else setTimeout(flush, 16)
  })

  // Newest-first for the viewer. `version` is read so the computed re-runs
  // on every (coalesced) buffer change.
  const entries = computed<readonly LogEntry[]>(() => {
    void version.value
    return logSnapshot().slice().reverse()
  })

  const count = computed<number>(() => {
    void version.value
    return logCount()
  })

  /** Plain-text dump (oldest-first) for clipboard / sharing. */
  function asText(): string {
    return logSnapshot()
      .map((e) => `${new Date(e.ts).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.text}`)
      .join("\n")
  }

  function clear(): void {
    clearLogs()
  }

  return { entries, count, asText, clear }
})

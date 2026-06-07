import { onBeforeUnmount, onMounted, watch } from "vue"
import { App, type AppState } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import { useLectorium } from "@lectorium/lectorium.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"

/**
 * Progress-emission cadence (ms) the audio engine should use to push
 * playback position into the WebView, by context. The native engines
 * stream `onProgress` at this rate while playing; the system player /
 * lock screen updates independently and interpolates position between
 * updates, so it stays smooth regardless of these values.
 *
 * Why this matters: while the app is backgrounded, Chromium throttles
 * the WebView, so a 2 Hz native stream queues up and flushes as one big
 * burst on resume — each event running full Vue reactivity (transcript
 * highlight recompute included). On slow devices that burst is a visible
 * freeze. Slowing the cadence (and pausing-ish it in the background)
 * keeps the backlog from ever forming.
 */
const INTERVAL_TRANSCRIPT_OPEN_MS = 500 // word-level highlight needs sub-second
const INTERVAL_FOREGROUND_MS = 1000 // floating-player progress ring only
const INTERVAL_BACKGROUND_MS = 5000 // app hidden — rare heartbeat

/**
 * App-root lifecycle hook that adapts the audio engine's progress cadence
 * to what the UI actually needs right now:
 *
 *   - foreground + transcript open  → fast   (sub-second word highlight)
 *   - foreground + transcript closed → medium (progress ring only)
 *   - background                     → slow   (heartbeat; nothing visible)
 *
 * Mount once near the app root (alongside `usePlayerProgressFlush`).
 */
export function usePlayerProgressCadence(): void {
  const app = useLectorium()
  const transcript = useTranscriptStore()

  let appActive = true
  let applied = -1
  let resumeHandle: PluginListenerHandle | null = null

  function desiredInterval(): number {
    if (!appActive) return INTERVAL_BACKGROUND_MS
    return transcript.open ? INTERVAL_TRANSCRIPT_OPEN_MS : INTERVAL_FOREGROUND_MS
  }

  function apply(): void {
    const next = desiredInterval()
    if (next === applied) return
    applied = next
    void app.audioPlayer.setProgressInterval(next)
  }

  const stopWatch = watch(() => transcript.open, apply)

  onMounted(() => {
    apply()
    void App.addListener("appStateChange", (state: AppState) => {
      appActive = state.isActive
      apply()
    }).then((handle) => {
      resumeHandle = handle
    })
  })

  onBeforeUnmount(() => {
    stopWatch()
    void resumeHandle?.remove()
    resumeHandle = null
  })
}

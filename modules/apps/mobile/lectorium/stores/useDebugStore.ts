import { ref } from "vue"
import { defineStore } from "pinia"

const UNLOCK_TAPS_REQUIRED = 5
const UNLOCK_TAP_WINDOW_MS = 3000

/**
 * Debug-mode gate copied from Shlokas. Settings keeps a plain `<p>` with
 * version/build/scheme at the bottom of the page; tapping it 5× within
 * a 3-second window unlocks a "Debug" section that exposes Clear-cache,
 * Clear-user-data, and Reset-tutorial entries. Once unlocked the flag
 * stays on for the session — a fresh app launch locks it again, which
 * matches the user-hidden expectation.
 */
export const useDebugStore = defineStore("debug", () => {
  const unlocked = ref<boolean>(false)
  let tapCount = 0
  let lastTapAt = 0

  function registerUnlockTap(): boolean {
    if (unlocked.value) return false
    const t = Date.now()
    if (t - lastTapAt > UNLOCK_TAP_WINDOW_MS) {
      tapCount = 0
    }
    lastTapAt = t
    tapCount += 1
    if (tapCount >= UNLOCK_TAPS_REQUIRED) {
      unlocked.value = true
      return true
    }
    return false
  }

  function lock(): void {
    unlocked.value = false
    tapCount = 0
  }

  return { unlocked, registerUnlockTap, lock }
})

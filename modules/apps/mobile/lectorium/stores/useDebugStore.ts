import { ref } from "vue"
import { defineStore } from "pinia"

/**
 * Owns the *session-scoped* debug-unlocked flag. The tap-to-unlock logic
 * itself lives in `@kit/composables`'s `useDebugUnlock`; this store is the
 * host that persists the resulting flag for the lifetime of the session.
 *
 * Settings keeps a plain build-info row at the bottom of the page; tapping
 * it 5× within a 3-second window (see `useDebugUnlockTrigger`) unlocks a
 * "Debug" section. The flag stays on for the session — a fresh app launch
 * locks it again, which matches the user-hidden expectation.
 */
export const useDebugStore = defineStore("debug", () => {
  const unlocked = ref<boolean>(false)

  function setUnlocked(value: boolean): void {
    unlocked.value = value
  }

  function lock(): void {
    unlocked.value = false
  }

  return { unlocked, setUnlocked, lock }
})

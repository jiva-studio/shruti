import { computed, ref, type ComputedRef } from "vue"

/**
 * Generic "tap N times within a window" unlocker — the classic hidden-debug
 * gate (e.g. tapping a version label 5× quickly reveals a Debug section).
 *
 * Pure Vue: no store, no persistence, no app domain. The host owns whether
 * the unlocked flag survives a relaunch — pass `initialUnlocked: true` to
 * start unlocked, and react to `onUnlock` to persist if desired.
 */
export interface UseDebugUnlockOptions {
  /** Taps required to unlock. Default 5. */
  readonly taps?: number
  /** Taps must land within this rolling window (ms). Default 3000. */
  readonly windowMs?: number
  /** Start already unlocked (e.g. rehydrated from storage). Default false. */
  readonly initialUnlocked?: boolean
  /** Fired once, the moment the threshold is reached. */
  readonly onUnlock?: () => void
  /** Clock source; override for tests. Default `Date.now`. */
  readonly now?: () => number
}

export interface UseDebugUnlock {
  /** Reactive unlocked state. */
  readonly unlocked: ComputedRef<boolean>
  /**
   * Record a tap. Returns true only on the tap that crosses the threshold
   * (so callers can fire a one-shot confirmation). No-op once unlocked.
   */
  registerTap(): boolean
  /** Force-unlock without tapping. */
  unlock(): void
  /** Reset to locked and clear the tap counter. */
  lock(): void
}

const DEFAULT_TAPS = 5
const DEFAULT_WINDOW_MS = 3000

export function useDebugUnlock(options: UseDebugUnlockOptions = {}): UseDebugUnlock {
  const taps = options.taps ?? DEFAULT_TAPS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const clock = options.now ?? Date.now

  const unlocked = ref(options.initialUnlocked ?? false)
  let tapCount = 0
  let lastTapAt = 0

  function registerTap(): boolean {
    if (unlocked.value) return false

    const t = clock()
    if (t - lastTapAt > windowMs) tapCount = 0
    lastTapAt = t
    tapCount += 1

    if (tapCount >= taps) {
      tapCount = 0
      unlocked.value = true
      options.onUnlock?.()
      return true
    }
    return false
  }

  function unlock(): void {
    if (unlocked.value) return
    tapCount = 0
    unlocked.value = true
    options.onUnlock?.()
  }

  function lock(): void {
    unlocked.value = false
    tapCount = 0
    lastTapAt = 0
  }

  return {
    unlocked: computed(() => unlocked.value),
    registerTap,
    unlock,
    lock,
  }
}

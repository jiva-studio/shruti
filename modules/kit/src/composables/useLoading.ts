import { computed, ref, type ComputedRef } from "vue"

/**
 * Ref-based loading-state helper. Pure Vue — no Ionic, no app domain.
 *
 * Uses a counter rather than a boolean so concurrent operations compose:
 * each `show()` increments, each `hide()` decrements, and `isLoading`
 * stays true until the last in-flight operation finishes. `wrap()` ties a
 * promise's lifetime to one show/hide pair via try/finally, so the flag
 * can't get stuck if the work throws.
 */
export interface UseLoading {
  /** True while at least one operation is in flight. */
  readonly isLoading: ComputedRef<boolean>
  /** Number of operations currently in flight. */
  readonly count: ComputedRef<number>
  /** Mark one operation as started. */
  show(): void
  /** Mark one operation as finished (never goes below zero). */
  hide(): void
  /** Run `fn` (or await a promise) with loading active for its duration. */
  wrap<T>(fn: Promise<T> | (() => Promise<T>)): Promise<T>
}

export function useLoading(): UseLoading {
  const count = ref(0)

  function show(): void {
    count.value += 1
  }

  function hide(): void {
    if (count.value > 0) count.value -= 1
  }

  async function wrap<T>(fn: Promise<T> | (() => Promise<T>)): Promise<T> {
    show()
    try {
      return await (typeof fn === "function" ? fn() : fn)
    } finally {
      hide()
    }
  }

  return {
    isLoading: computed(() => count.value > 0),
    count: computed(() => count.value),
    show,
    hide,
    wrap,
  }
}

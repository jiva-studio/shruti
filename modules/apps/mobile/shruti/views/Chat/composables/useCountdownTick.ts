import { onBeforeUnmount, ref, watch, type Ref } from "vue"

/**
 * A `now` that ticks once a second while a deadline is pending, so anything
 * derived from it — a countdown body, a retry button's enabled state — moves
 * live and then stops. Watched rather than started on mount, so a deadline
 * that arrives late still gets its countdown.
 */
export function useCountdownTick(deadline: () => number | null): Ref<number> {
  const now = ref(Date.now())
  let handle: ReturnType<typeof setInterval> | null = null

  function stop(): void {
    if (handle !== null) {
      clearInterval(handle)
      handle = null
    }
  }

  watch(
    deadline,
    (at) => {
      stop()
      if (at === null) return
      now.value = Date.now()
      handle = setInterval(() => {
        now.value = Date.now()
        if (now.value >= at) stop()
      }, 1000)
    },
    { immediate: true }
  )

  onBeforeUnmount(stop)

  return now
}

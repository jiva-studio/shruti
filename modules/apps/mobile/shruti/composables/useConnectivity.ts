import { onBeforeUnmount, onMounted, ref, type Ref } from "vue"

/**
 * Device online/offline state, shared by every caller.
 *
 * The `online`/`offline` window listeners are registered ONCE — the first
 * mounted consumer attaches them, the last one to unmount detaches them —
 * so a screen that instantiates this from N components still costs O(1)
 * registrations instead of O(N). The reactive `isOffline` ref is a single
 * module-level cell, so N consumers share one dependency node too.
 */

const isOffline = ref<boolean>(readNavigatorOffline())
const reconnectHandlers = new Set<() => void>()
let consumers = 0

function readNavigatorOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

function handleOnline(): void {
  isOffline.value = false
  // Copy: a handler is free to unsubscribe itself while we iterate.
  for (const handler of [...reconnectHandlers]) handler()
}

function handleOffline(): void {
  isOffline.value = true
}

function acquire(): void {
  consumers += 1
  if (consumers > 1) return
  if (typeof window === "undefined") return
  // Re-sample: the flag may have moved while nobody was listening.
  isOffline.value = readNavigatorOffline()
  window.addEventListener("online", handleOnline)
  window.addEventListener("offline", handleOffline)
}

function release(): void {
  consumers = Math.max(0, consumers - 1)
  if (consumers > 0) return
  if (typeof window === "undefined") return
  window.removeEventListener("online", handleOnline)
  window.removeEventListener("offline", handleOffline)
}

export interface UseConnectivityOptions {
  /** Called on every `online` transition, after `isOffline` flips false. */
  onReconnect?: () => void
}

export interface UseConnectivityReturn {
  /** True while the device reports itself offline. */
  isOffline: Readonly<Ref<boolean>>
}

export function useConnectivity(options: UseConnectivityOptions = {}): UseConnectivityReturn {
  const { onReconnect } = options

  onMounted(() => {
    acquire()
    if (onReconnect) reconnectHandlers.add(onReconnect)
  })

  onBeforeUnmount(() => {
    if (onReconnect) reconnectHandlers.delete(onReconnect)
    release()
  })

  return { isOffline }
}

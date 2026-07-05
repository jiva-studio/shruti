/**
 * Module-level event bus for profile-sync trigger signals. Decouples the code
 * that produces a local change (a mutating store / use-case) from the sync
 * engine's trigger composable (`useSyncEngine`), exactly like the proactive
 * bus decouples the scheduler from its consumers.
 *
 * A mutating flow that just journaled a change into the outbox calls
 * {@link requestSync}; the composable debounces those into a single push cycle.
 * Producers never import the composable or the engine — they emit "something
 * changed" and stay oblivious to who reacts (or whether sync is even enabled).
 *
 * One event:
 *   - `sync-requested` — local data changed; the engine should sync soon
 *     (debounced). Cheap to over-emit — the composable coalesces.
 *
 * Listeners run synchronously inside emit; a throwing listener is swallowed so
 * one bad subscriber can't take the bus down.
 */

export type SyncEvent = "sync-requested"

const listeners = new Map<SyncEvent, Set<() => void>>()

export function onSyncEvent(event: SyncEvent, fn: () => void): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
  }
}

function emit(event: SyncEvent): void {
  const set = listeners.get(event)
  if (!set) return
  for (const fn of set) {
    try {
      fn()
    } catch (err) {
      console.warn("[sync/events]", event, "listener threw:", err)
    }
  }
}

/** Signal that local synced data changed; the engine debounces a push cycle. */
export function requestSync(): void {
  emit("sync-requested")
}

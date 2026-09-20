import { effectScope, ref, watch, type Ref } from "vue"

/**
 * Minimal async key-value store this composable binds to. Apps adapt their
 * platform preferences (Capacitor, localStorage, an in-memory fake in tests)
 * to this shape — kit stays framework- and platform-agnostic.
 */
export interface PreferencesPort {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export type ConfigSerializer<T> = {
  encode: (value: T) => string
  decode: (raw: string) => T
}

const JSON_SERIALIZER: ConfigSerializer<unknown> = {
  encode: (v) => JSON.stringify(v),
  decode: (s) => JSON.parse(s),
}

/**
 * Factory for a reactive key-value config binder. Pass the preferences port
 * (get/set) once; the returned `useConfig` two-way binds typed config values
 * to it.
 *
 * Shared refs are cached **per factory instance** so multiple callers for the
 * same key get the same `Ref` — a write from one consumer is seen live by the
 * others. Each app composition root creates exactly one factory so its cache
 * is isolated (and tests get a fresh cache per factory).
 *
 * Values are JSON-serialized by default so booleans, numbers, strings, and
 * arrays all round-trip. Use this for **edge** settings (toggles, chosen
 * locale, notification preferences) that don't warrant a schema migration.
 */
export function createUseConfig(preferences: PreferencesPort) {
  // Shared refs — multiple callers for the same key get the same Ref so
  // a write from one consumer is seen live by every other consumer.
  const cache = new Map<string, Ref<unknown>>()

  function useConfig<T>(
    key: string,
    initial: T,
    serializer: ConfigSerializer<T> = JSON_SERIALIZER as ConfigSerializer<T>
  ): Ref<T> {
    const cached = cache.get(key)
    if (cached) return cached as Ref<T>

    // Detached scope so hydrate + persist watcher survive the first
    // consumer's unmount — otherwise the watcher dies with that scope
    // and later mutations from other consumers never reach storage.
    const scope = effectScope(true)
    const state = scope.run(() => {
      const inner = ref(initial) as Ref<T>
      let hydrated = false
      let writing = false
      let queued: { payload: string } | null = null

      void (async () => {
        const raw = await preferences.get(key)
        if (raw !== null) {
          try {
            inner.value = serializer.decode(raw)
          } catch {
            // Corrupt payload — leave the initial value in place so the
            // consumer still gets a working value.
          }
        }
        hydrated = true
      })()

      // One write in flight at a time, plus a single slot holding the newest
      // payload seen while it runs. Changes arriving during a write overwrite
      // that slot instead of queueing, so a burst collapses to at most two
      // writes while the trailing one still carries the final value.
      const write = (payload: string): void => {
        writing = true
        void preferences
          .set(key, payload)
          // A rejected write is reported by the port, not retried here — a
          // failing store would otherwise spin. The mechanism stays live.
          .catch(() => {})
          .then(() => {
            writing = false
            const trailing = queued
            queued = null
            if (trailing) write(trailing.payload)
          })
      }

      watch(
        inner,
        (next) => {
          if (!hydrated) return
          // Encode eagerly: `deep` fires on in-place mutation, so a deferred
          // encode would snapshot a later state than the one that fired.
          const payload = serializer.encode(next)
          if (writing) {
            queued = { payload }
            return
          }
          write(payload)
        },
        { deep: true }
      )

      return inner
    })!

    cache.set(key, state as Ref<unknown>)
    return state
  }

  return useConfig
}

/** The reactive key-value config binder produced by {@link createUseConfig}. */
export type UseConfig = ReturnType<typeof createUseConfig>

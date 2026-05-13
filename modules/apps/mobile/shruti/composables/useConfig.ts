import { effectScope, ref, watch, type Ref } from "vue"
import { useShruti } from "@shruti/shruti.js"

type Serializer<T> = {
  encode: (value: T) => string
  decode: (raw: string) => T
}

const JSON_SERIALIZER: Serializer<unknown> = {
  encode: (v) => JSON.stringify(v),
  decode: (s) => JSON.parse(s),
}

// Shared refs — multiple callers for the same key get the same Ref so
// a write from Settings is seen live by TabsLayout / App / PlayerStore.
const CACHE = new Map<string, Ref<unknown>>()

/**
 * Two-way binds a typed config value to `IPreferences`. Returns a ref
 * that hydrates asynchronously from storage on first access and writes
 * back whenever it changes. Values are JSON-serialized by default so
 * booleans, numbers, strings, and arrays all round-trip.
 *
 * Use this for **edge** settings (toggles, chosen locale, notification
 * preferences) that don't warrant a SQL migration. Domain data must
 * still live in repos.
 */
export function useConfig<T>(
  key: string,
  initial: T,
  serializer: Serializer<T> = JSON_SERIALIZER as Serializer<T>
): Ref<T> {
  const cached = CACHE.get(key)
  if (cached) return cached as Ref<T>

  const app = useShruti()
  // Detached scope so hydrate + persist watcher survive the first
  // consumer's unmount — otherwise the watcher dies with that scope
  // and later mutations from other consumers never reach storage.
  const scope = effectScope(true)
  const state = scope.run(() => {
    const inner = ref(initial) as Ref<T>
    let hydrated = false
    let persisting = false

    void (async () => {
      const raw = await app.preferences.get(key)
      if (raw !== null) {
        try {
          inner.value = serializer.decode(raw)
        } catch {
          // Corrupt payload — leave the initial value in place so the
          // user still gets a working app.
        }
      }
      hydrated = true
    })()

    watch(
      inner,
      (next) => {
        if (!hydrated || persisting) return
        persisting = true
        void app.preferences.set(key, serializer.encode(next)).finally(() => {
          persisting = false
        })
      },
      { deep: true }
    )

    return inner
  })!

  CACHE.set(key, state as Ref<unknown>)
  return state
}

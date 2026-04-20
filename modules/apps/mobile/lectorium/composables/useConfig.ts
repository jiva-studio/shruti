import { ref, watch, type Ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"

type Serializer<T> = {
  encode: (value: T) => string
  decode: (raw: string) => T
}

const JSON_SERIALIZER: Serializer<unknown> = {
  encode: (v) => JSON.stringify(v),
  decode: (s) => JSON.parse(s),
}

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
export function useConfig<T>(key: string, initial: T, serializer: Serializer<T> = JSON_SERIALIZER as Serializer<T>): Ref<T> {
  const app = useLectorium()
  const state = ref(initial) as Ref<T>

  let hydrated = false
  let persisting = false

  void (async () => {
    const raw = await app.preferences.get(key)
    if (raw !== null) {
      try {
        state.value = serializer.decode(raw)
      } catch {
        // Corrupt payload — leave the initial value in place so the
        // user still gets a working app.
      }
    }
    hydrated = true
  })()

  watch(
    state,
    (next) => {
      if (!hydrated || persisting) return
      persisting = true
      void app.preferences.set(key, serializer.encode(next)).finally(() => {
        persisting = false
      })
    },
    { deep: true }
  )

  return state
}

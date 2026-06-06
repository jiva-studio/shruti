import { type Ref } from "vue"
import { createUseConfig, type ConfigSerializer, type UseConfig } from "@kit/composables"
import { useShruti } from "@shruti/shruti.js"

/** Encode/decode pair for a stored config value (defaults to JSON). */
export type Serializer<T> = ConfigSerializer<T>

// One app-wide binder so its key→ref cache is shared across every consumer
// (a write from Settings is seen live by App / PlayerStore / schedulers).
// Built lazily on first call so it picks up the initialised composition root.
let binder: UseConfig | undefined

/**
 * Two-way binds a typed config value to `IPreferences`. Thin wrapper over
 * kit's `createUseConfig`, wired to this app's composition-root preferences
 * port. Returns a ref that hydrates asynchronously from storage on first
 * access and writes back whenever it changes; values are JSON-serialized by
 * default so booleans, numbers, strings, and arrays all round-trip.
 *
 * Use this for **edge** settings (toggles, chosen locale, notification
 * preferences) that don't warrant a SQL migration. Domain data must still
 * live in repos.
 */
export function useConfig<T>(key: string, initial: T, serializer?: Serializer<T>): Ref<T> {
  binder ??= createUseConfig(useShruti().preferences)
  return binder(key, initial, serializer)
}

import { Preferences } from "@capacitor/preferences"

/**
 * Every key currently held by the preference store.
 *
 * `IPreferences` is a deliberate get/set/remove port: settings are read by
 * name, so enumeration is not part of it. `useSyncEngine`'s one-time origin
 * recovery needs it anyway to answer "has any identity other than this one ever
 * run on this device", and the only record of that is the set of
 * `sync.backfilled.<userId>` markers, whose ids it does not know.
 *
 * Backed by the same `@capacitor/preferences` store as the port itself
 * (SharedPreferences / UserDefaults / localStorage), so it sees exactly the
 * keys that adapter writes.
 */
export function useCapacitorPreferenceKeys(): () => Promise<readonly string[]> {
  return async () => (await Preferences.keys()).keys
}

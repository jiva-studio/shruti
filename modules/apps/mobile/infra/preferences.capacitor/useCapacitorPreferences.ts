import { Preferences } from "@capacitor/preferences"
import type { IPreferences } from "@ports/app/index.js"

/**
 * {@link IPreferences} adapter backed by `@capacitor/preferences`.
 * Uses SharedPreferences on Android, UserDefaults on iOS, and
 * localStorage on web — no platform branching needed.
 */
export function useCapacitorPreferences(): IPreferences {
  return {
    async get(key: string): Promise<string | null> {
      const { value } = await Preferences.get({ key })
      return value
    },
    async set(key: string, value: string): Promise<void> {
      await Preferences.set({ key, value })
    },
    async remove(key: string): Promise<void> {
      await Preferences.remove({ key })
    },
  }
}

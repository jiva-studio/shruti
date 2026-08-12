import { type Ref } from "vue"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { markStoredAppLanguageApplied } from "@lectorium/composables/appLanguageApplied.js"
import {
  currentLocale,
  setLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@lectorium/i18n/index.js"

/** Preferences key the UI-language setting is persisted under. */
export const APP_LANGUAGE_KEY = "settings.appLanguage"

/** The subset of the preferences port these helpers need. `main.ts` reaches
 *  for them before the composition root's config binder exists. */
interface PreferencesLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

/**
 * The app-wide UI language setting (`settings.appLanguage`). One
 * source of truth for every controller that needs to localise
 * dictionary lookups: buildTrackRow picks author/location/source
 * names via `preferredLanguage = useAppLanguage().value`.
 *
 * Falls back to the device locale on first launch; the Settings
 * screen binds a chooser to the same `useConfig` key so changes
 * propagate reactively.
 *
 * Seeded from `currentLocale()` — the language actually on screen — rather
 * than `detectLocale()`, the device one. `useConfig` hydrates asynchronously,
 * so the seed is what every consumer reads for the first tens of milliseconds:
 * `repositories()`' `getActiveLanguage`, the chat answer language, and the
 * watcher in `useLocaleSync`. On a launch where `applyStoredAppLanguage`
 * already put the stored choice on screen, the device locale is simply the
 * wrong answer there (#1742). On a first launch the two are the same value,
 * because i18n boots on `detectLocale()`.
 */
export function useAppLanguage(): Ref<string> {
  return useConfig<string>(APP_LANGUAGE_KEY, currentLocale())
}

/** The persisted UI-language choice, or null when the user never made one.
 *  `useConfig` JSON-encodes its values, so the stored payload is `"ru"`. */
export async function readStoredAppLanguage(
  preferences: PreferencesLike
): Promise<SupportedLocale | null> {
  const raw = await preferences.get(APP_LANGUAGE_KEY).catch(() => null)
  if (raw === null) return null
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  } catch {
    // Not JSON — an older build wrote the bare code. Take it as-is.
  }
  return (SUPPORTED_LOCALES as readonly string[]).includes(value as string)
    ? (value as SupportedLocale)
    : null
}

/**
 * Apply the persisted UI language before the first paint.
 *
 * The i18n module boots on the DEVICE locale, which is not necessarily the one
 * the user chose — a phone in English with Русский selected used to mount fully
 * in English and only swap once `useConfig` had hydrated, a whole-screen flash
 * (issue #1606). Reading the preference during startup costs one more
 * `preferences.get` and removes it.
 *
 * A stored locale whose chunk cannot be loaded is rewritten to whatever the UI
 * actually ended up in, so the picker can't keep claiming a language nothing on
 * screen is written in. Never rejects.
 */
export async function applyStoredAppLanguage(preferences: PreferencesLike): Promise<void> {
  const stored = await readStoredAppLanguage(preferences)
  if (stored === null) return
  markStoredAppLanguageApplied()
  if (stored === currentLocale()) return
  if ((await setLocale(stored)) !== "failed") return
  await preferences.set(APP_LANGUAGE_KEY, JSON.stringify(currentLocale())).catch(() => undefined)
}

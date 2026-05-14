import { createI18n } from "vue-i18n"

import enActivity from "./locales/en/activity.js"
import enApp from "./locales/en/app.js"
import enErrors from "./locales/en/errors.js"
import enHome from "./locales/en/home.js"
import enLibrary from "./locales/en/library.js"
import enNotes from "./locales/en/notes.js"
import enNotifications from "./locales/en/notifications.js"
import enPlayer from "./locales/en/player.js"
import enSearch from "./locales/en/search.js"
import enSettings from "./locales/en/settings.js"
import enShare from "./locales/en/share.js"
import enTranscript from "./locales/en/transcript.js"
import enWelcome from "./locales/en/welcome.js"

import ruActivity from "./locales/ru/activity.js"
import ruApp from "./locales/ru/app.js"
import ruErrors from "./locales/ru/errors.js"
import ruHome from "./locales/ru/home.js"
import ruLibrary from "./locales/ru/library.js"
import ruNotes from "./locales/ru/notes.js"
import ruNotifications from "./locales/ru/notifications.js"
import ruPlayer from "./locales/ru/player.js"
import ruSearch from "./locales/ru/search.js"
import ruSettings from "./locales/ru/settings.js"
import ruShare from "./locales/ru/share.js"
import ruTranscript from "./locales/ru/transcript.js"
import ruWelcome from "./locales/ru/welcome.js"

export const SUPPORTED_LOCALES = ["en", "ru"] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const en = {
  activity: enActivity,
  app: enApp,
  errors: enErrors,
  home: enHome,
  library: enLibrary,
  notes: enNotes,
  notifications: enNotifications,
  player: enPlayer,
  search: enSearch,
  settings: enSettings,
  share: enShare,
  transcript: enTranscript,
  welcome: enWelcome,
}

const ru = {
  activity: ruActivity,
  app: ruApp,
  errors: ruErrors,
  home: ruHome,
  library: ruLibrary,
  notes: ruNotes,
  notifications: ruNotifications,
  player: ruPlayer,
  search: ruSearch,
  settings: ruSettings,
  share: ruShare,
  transcript: ruTranscript,
  welcome: ruWelcome,
}

/**
 * Pick a UI locale based on `navigator.language`. Sync — safe to call
 * at module load. On Capacitor's WebView `navigator.language` already
 * mirrors the OS locale, so this is enough for the initial i18n boot
 * and the `useAppLanguage` default. For the search-filter first-launch
 * seed we prefer {@link detectDeviceLocaleAsync}, which goes through
 * the native Device plugin and falls back to this on failure.
 */
export function detectLocale(): SupportedLocale {
  // `?locale=en|ru` overrides device locale — used by the screenshots pipeline
  // (modules/tools/screenshots) to capture each locale deterministically
  // without touching the Settings UI.
  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get("locale")
    if (fromQuery && (SUPPORTED_LOCALES as readonly string[]).includes(fromQuery)) {
      return fromQuery as SupportedLocale
    }
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "en"
  return toSupportedLocale(nav)
}

/**
 * Asks the native Capacitor Device plugin for the device language; on
 * failure (e.g. plugin not registered, web environment without the
 * shim) falls back to {@link detectLocale}.
 */
export async function detectDeviceLocaleAsync(): Promise<SupportedLocale> {
  try {
    const { Device } = await import("@capacitor/device")
    const { value } = await Device.getLanguageCode()
    return toSupportedLocale(value)
  } catch {
    return detectLocale()
  }
}

function toSupportedLocale(raw: string | null | undefined): SupportedLocale {
  const short = (raw ?? "en").split("-")[0] as SupportedLocale
  return (SUPPORTED_LOCALES as readonly string[]).includes(short) ? short : "en"
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { en, ru },
})

export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale
}

export function currentLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale
}

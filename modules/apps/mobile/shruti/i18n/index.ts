import { createI18n } from "vue-i18n"

import enActivity from "./locales/en/activity.js"
import enApp from "./locales/en/app.js"
import enChat from "./locales/en/chat.js"
import enErrors from "./locales/en/errors.js"
import enHelp from "./locales/en/help.js"
import enHome from "./locales/en/home.js"
import enLibrary from "./locales/en/library.js"
import enNotes from "./locales/en/notes.js"
import enNotifications from "./locales/en/notifications.js"
import enPlayer from "./locales/en/player.js"
import enSearch from "./locales/en/search.js"
import enSettings from "./locales/en/settings.js"
import enShare from "./locales/en/share.js"
import enStudio from "./locales/en/studio.js"
import enTranscript from "./locales/en/transcript.js"
import enWelcome from "./locales/en/welcome.js"

import ruActivity from "./locales/ru/activity.js"
import ruApp from "./locales/ru/app.js"
import ruChat from "./locales/ru/chat.js"
import ruErrors from "./locales/ru/errors.js"
import ruHelp from "./locales/ru/help.js"
import ruHome from "./locales/ru/home.js"
import ruLibrary from "./locales/ru/library.js"
import ruNotes from "./locales/ru/notes.js"
import ruNotifications from "./locales/ru/notifications.js"
import ruPlayer from "./locales/ru/player.js"
import ruSearch from "./locales/ru/search.js"
import ruSettings from "./locales/ru/settings.js"
import ruShare from "./locales/ru/share.js"
import ruStudio from "./locales/ru/studio.js"
import ruTranscript from "./locales/ru/transcript.js"
import ruWelcome from "./locales/ru/welcome.js"

import ukActivity from "./locales/uk/activity.js"
import ukApp from "./locales/uk/app.js"
import ukChat from "./locales/uk/chat.js"
import ukErrors from "./locales/uk/errors.js"
import ukHelp from "./locales/uk/help.js"
import ukHome from "./locales/uk/home.js"
import ukLibrary from "./locales/uk/library.js"
import ukNotes from "./locales/uk/notes.js"
import ukNotifications from "./locales/uk/notifications.js"
import ukPlayer from "./locales/uk/player.js"
import ukSearch from "./locales/uk/search.js"
import ukSettings from "./locales/uk/settings.js"
import ukShare from "./locales/uk/share.js"
import ukStudio from "./locales/uk/studio.js"
import ukTranscript from "./locales/uk/transcript.js"
import ukWelcome from "./locales/uk/welcome.js"

import srLatnActivity from "./locales/sr-Latn/activity.js"
import srLatnApp from "./locales/sr-Latn/app.js"
import srLatnChat from "./locales/sr-Latn/chat.js"
import srLatnErrors from "./locales/sr-Latn/errors.js"
import srLatnHelp from "./locales/sr-Latn/help.js"
import srLatnHome from "./locales/sr-Latn/home.js"
import srLatnLibrary from "./locales/sr-Latn/library.js"
import srLatnNotes from "./locales/sr-Latn/notes.js"
import srLatnNotifications from "./locales/sr-Latn/notifications.js"
import srLatnPlayer from "./locales/sr-Latn/player.js"
import srLatnSearch from "./locales/sr-Latn/search.js"
import srLatnSettings from "./locales/sr-Latn/settings.js"
import srLatnShare from "./locales/sr-Latn/share.js"
import srLatnStudio from "./locales/sr-Latn/studio.js"
import srLatnTranscript from "./locales/sr-Latn/transcript.js"
import srLatnWelcome from "./locales/sr-Latn/welcome.js"

import srCyrlActivity from "./locales/sr-Cyrl/activity.js"
import srCyrlApp from "./locales/sr-Cyrl/app.js"
import srCyrlChat from "./locales/sr-Cyrl/chat.js"
import srCyrlErrors from "./locales/sr-Cyrl/errors.js"
import srCyrlHelp from "./locales/sr-Cyrl/help.js"
import srCyrlHome from "./locales/sr-Cyrl/home.js"
import srCyrlLibrary from "./locales/sr-Cyrl/library.js"
import srCyrlNotes from "./locales/sr-Cyrl/notes.js"
import srCyrlNotifications from "./locales/sr-Cyrl/notifications.js"
import srCyrlPlayer from "./locales/sr-Cyrl/player.js"
import srCyrlSearch from "./locales/sr-Cyrl/search.js"
import srCyrlSettings from "./locales/sr-Cyrl/settings.js"
import srCyrlShare from "./locales/sr-Cyrl/share.js"
import srCyrlStudio from "./locales/sr-Cyrl/studio.js"
import srCyrlTranscript from "./locales/sr-Cyrl/transcript.js"
import srCyrlWelcome from "./locales/sr-Cyrl/welcome.js"

export const SUPPORTED_LOCALES = ["en", "ru", "uk", "sr-Latn", "sr-Cyrl"] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const en = {
  activity: enActivity,
  app: enApp,
  chat: enChat,
  errors: enErrors,
  help: enHelp,
  home: enHome,
  library: enLibrary,
  notes: enNotes,
  notifications: enNotifications,
  player: enPlayer,
  search: enSearch,
  settings: enSettings,
  share: enShare,
  studio: enStudio,
  transcript: enTranscript,
  welcome: enWelcome,
}

const ru = {
  activity: ruActivity,
  app: ruApp,
  chat: ruChat,
  errors: ruErrors,
  help: ruHelp,
  home: ruHome,
  library: ruLibrary,
  notes: ruNotes,
  notifications: ruNotifications,
  player: ruPlayer,
  search: ruSearch,
  settings: ruSettings,
  share: ruShare,
  studio: ruStudio,
  transcript: ruTranscript,
  welcome: ruWelcome,
}

const uk = {
  activity: ukActivity,
  app: ukApp,
  chat: ukChat,
  errors: ukErrors,
  help: ukHelp,
  home: ukHome,
  library: ukLibrary,
  notes: ukNotes,
  notifications: ukNotifications,
  player: ukPlayer,
  search: ukSearch,
  settings: ukSettings,
  share: ukShare,
  studio: ukStudio,
  transcript: ukTranscript,
  welcome: ukWelcome,
}

const srLatn = {
  activity: srLatnActivity,
  app: srLatnApp,
  chat: srLatnChat,
  errors: srLatnErrors,
  help: srLatnHelp,
  home: srLatnHome,
  library: srLatnLibrary,
  notes: srLatnNotes,
  notifications: srLatnNotifications,
  player: srLatnPlayer,
  search: srLatnSearch,
  settings: srLatnSettings,
  share: srLatnShare,
  studio: srLatnStudio,
  transcript: srLatnTranscript,
  welcome: srLatnWelcome,
}

const srCyrl = {
  activity: srCyrlActivity,
  app: srCyrlApp,
  chat: srCyrlChat,
  errors: srCyrlErrors,
  help: srCyrlHelp,
  home: srCyrlHome,
  library: srCyrlLibrary,
  notes: srCyrlNotes,
  notifications: srCyrlNotifications,
  player: srCyrlPlayer,
  search: srCyrlSearch,
  settings: srCyrlSettings,
  share: srCyrlShare,
  studio: srCyrlStudio,
  transcript: srCyrlTranscript,
  welcome: srCyrlWelcome,
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
  const code = raw ?? "en"
  // Match the full code first — `sr-Latn` / `sr-Cyrl` carry a meaningful
  // script subtag, so stripping it would collapse both to `sr` and miss.
  if ((SUPPORTED_LOCALES as readonly string[]).includes(code)) {
    return code as SupportedLocale
  }
  // Fall back to the primary subtag so region variants like `uk-UA` →
  // `uk` or `en-US` → `en` still resolve.
  const short = code.split("-")[0] as SupportedLocale
  return (SUPPORTED_LOCALES as readonly string[]).includes(short) ? short : "en"
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { en, ru, uk, "sr-Latn": srLatn, "sr-Cyrl": srCyrl },
})

export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale
}

export function currentLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale
}

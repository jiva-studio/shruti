import { createI18n } from "vue-i18n"

import enApp from "./locales/en/app.js"
import enErrors from "./locales/en/errors.js"
import enHome from "./locales/en/home.js"
import enLibrary from "./locales/en/library.js"
import enNotes from "./locales/en/notes.js"
import enNotifications from "./locales/en/notifications.js"
import enSearch from "./locales/en/search.js"
import enSettings from "./locales/en/settings.js"
import enShare from "./locales/en/share.js"
import enTranscript from "./locales/en/transcript.js"
import enWelcome from "./locales/en/welcome.js"

import ruApp from "./locales/ru/app.js"
import ruErrors from "./locales/ru/errors.js"
import ruHome from "./locales/ru/home.js"
import ruLibrary from "./locales/ru/library.js"
import ruNotes from "./locales/ru/notes.js"
import ruNotifications from "./locales/ru/notifications.js"
import ruSearch from "./locales/ru/search.js"
import ruSettings from "./locales/ru/settings.js"
import ruShare from "./locales/ru/share.js"
import ruTranscript from "./locales/ru/transcript.js"
import ruWelcome from "./locales/ru/welcome.js"

export const SUPPORTED_LOCALES = ["en", "ru"] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const en = {
  app: enApp,
  errors: enErrors,
  home: enHome,
  library: enLibrary,
  notes: enNotes,
  notifications: enNotifications,
  search: enSearch,
  settings: enSettings,
  share: enShare,
  transcript: enTranscript,
  welcome: enWelcome,
}

const ru = {
  app: ruApp,
  errors: ruErrors,
  home: ruHome,
  library: ruLibrary,
  notes: ruNotes,
  notifications: ruNotifications,
  search: ruSearch,
  settings: ruSettings,
  share: ruShare,
  transcript: ruTranscript,
  welcome: ruWelcome,
}

function detectLocale(): SupportedLocale {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en"
  const short = nav.split("-")[0] as SupportedLocale
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

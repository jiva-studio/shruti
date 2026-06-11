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

import esActivity from "./locales/es/activity.js"
import esApp from "./locales/es/app.js"
import esChat from "./locales/es/chat.js"
import esErrors from "./locales/es/errors.js"
import esHelp from "./locales/es/help.js"
import esHome from "./locales/es/home.js"
import esLibrary from "./locales/es/library.js"
import esNotes from "./locales/es/notes.js"
import esNotifications from "./locales/es/notifications.js"
import esPlayer from "./locales/es/player.js"
import esSearch from "./locales/es/search.js"
import esSettings from "./locales/es/settings.js"
import esShare from "./locales/es/share.js"
import esStudio from "./locales/es/studio.js"
import esTranscript from "./locales/es/transcript.js"
import esWelcome from "./locales/es/welcome.js"

import ptActivity from "./locales/pt/activity.js"
import ptApp from "./locales/pt/app.js"
import ptChat from "./locales/pt/chat.js"
import ptErrors from "./locales/pt/errors.js"
import ptHelp from "./locales/pt/help.js"
import ptHome from "./locales/pt/home.js"
import ptLibrary from "./locales/pt/library.js"
import ptNotes from "./locales/pt/notes.js"
import ptNotifications from "./locales/pt/notifications.js"
import ptPlayer from "./locales/pt/player.js"
import ptSearch from "./locales/pt/search.js"
import ptSettings from "./locales/pt/settings.js"
import ptShare from "./locales/pt/share.js"
import ptStudio from "./locales/pt/studio.js"
import ptTranscript from "./locales/pt/transcript.js"
import ptWelcome from "./locales/pt/welcome.js"

import itActivity from "./locales/it/activity.js"
import itApp from "./locales/it/app.js"
import itChat from "./locales/it/chat.js"
import itErrors from "./locales/it/errors.js"
import itHelp from "./locales/it/help.js"
import itHome from "./locales/it/home.js"
import itLibrary from "./locales/it/library.js"
import itNotes from "./locales/it/notes.js"
import itNotifications from "./locales/it/notifications.js"
import itPlayer from "./locales/it/player.js"
import itSearch from "./locales/it/search.js"
import itSettings from "./locales/it/settings.js"
import itShare from "./locales/it/share.js"
import itStudio from "./locales/it/studio.js"
import itTranscript from "./locales/it/transcript.js"
import itWelcome from "./locales/it/welcome.js"

import deActivity from "./locales/de/activity.js"
import deApp from "./locales/de/app.js"
import deChat from "./locales/de/chat.js"
import deErrors from "./locales/de/errors.js"
import deHelp from "./locales/de/help.js"
import deHome from "./locales/de/home.js"
import deLibrary from "./locales/de/library.js"
import deNotes from "./locales/de/notes.js"
import deNotifications from "./locales/de/notifications.js"
import dePlayer from "./locales/de/player.js"
import deSearch from "./locales/de/search.js"
import deSettings from "./locales/de/settings.js"
import deShare from "./locales/de/share.js"
import deStudio from "./locales/de/studio.js"
import deTranscript from "./locales/de/transcript.js"
import deWelcome from "./locales/de/welcome.js"

import frActivity from "./locales/fr/activity.js"
import frApp from "./locales/fr/app.js"
import frChat from "./locales/fr/chat.js"
import frErrors from "./locales/fr/errors.js"
import frHelp from "./locales/fr/help.js"
import frHome from "./locales/fr/home.js"
import frLibrary from "./locales/fr/library.js"
import frNotes from "./locales/fr/notes.js"
import frNotifications from "./locales/fr/notifications.js"
import frPlayer from "./locales/fr/player.js"
import frSearch from "./locales/fr/search.js"
import frSettings from "./locales/fr/settings.js"
import frShare from "./locales/fr/share.js"
import frStudio from "./locales/fr/studio.js"
import frTranscript from "./locales/fr/transcript.js"
import frWelcome from "./locales/fr/welcome.js"

import plActivity from "./locales/pl/activity.js"
import plApp from "./locales/pl/app.js"
import plChat from "./locales/pl/chat.js"
import plErrors from "./locales/pl/errors.js"
import plHelp from "./locales/pl/help.js"
import plHome from "./locales/pl/home.js"
import plLibrary from "./locales/pl/library.js"
import plNotes from "./locales/pl/notes.js"
import plNotifications from "./locales/pl/notifications.js"
import plPlayer from "./locales/pl/player.js"
import plSearch from "./locales/pl/search.js"
import plSettings from "./locales/pl/settings.js"
import plShare from "./locales/pl/share.js"
import plStudio from "./locales/pl/studio.js"
import plTranscript from "./locales/pl/transcript.js"
import plWelcome from "./locales/pl/welcome.js"

import huActivity from "./locales/hu/activity.js"
import huApp from "./locales/hu/app.js"
import huChat from "./locales/hu/chat.js"
import huErrors from "./locales/hu/errors.js"
import huHelp from "./locales/hu/help.js"
import huHome from "./locales/hu/home.js"
import huLibrary from "./locales/hu/library.js"
import huNotes from "./locales/hu/notes.js"
import huNotifications from "./locales/hu/notifications.js"
import huPlayer from "./locales/hu/player.js"
import huSearch from "./locales/hu/search.js"
import huSettings from "./locales/hu/settings.js"
import huShare from "./locales/hu/share.js"
import huStudio from "./locales/hu/studio.js"
import huTranscript from "./locales/hu/transcript.js"
import huWelcome from "./locales/hu/welcome.js"

import hiActivity from "./locales/hi/activity.js"
import hiApp from "./locales/hi/app.js"
import hiChat from "./locales/hi/chat.js"
import hiErrors from "./locales/hi/errors.js"
import hiHelp from "./locales/hi/help.js"
import hiHome from "./locales/hi/home.js"
import hiLibrary from "./locales/hi/library.js"
import hiNotes from "./locales/hi/notes.js"
import hiNotifications from "./locales/hi/notifications.js"
import hiPlayer from "./locales/hi/player.js"
import hiSearch from "./locales/hi/search.js"
import hiSettings from "./locales/hi/settings.js"
import hiShare from "./locales/hi/share.js"
import hiStudio from "./locales/hi/studio.js"
import hiTranscript from "./locales/hi/transcript.js"
import hiWelcome from "./locales/hi/welcome.js"

import bnActivity from "./locales/bn/activity.js"
import bnApp from "./locales/bn/app.js"
import bnChat from "./locales/bn/chat.js"
import bnErrors from "./locales/bn/errors.js"
import bnHelp from "./locales/bn/help.js"
import bnHome from "./locales/bn/home.js"
import bnLibrary from "./locales/bn/library.js"
import bnNotes from "./locales/bn/notes.js"
import bnNotifications from "./locales/bn/notifications.js"
import bnPlayer from "./locales/bn/player.js"
import bnSearch from "./locales/bn/search.js"
import bnSettings from "./locales/bn/settings.js"
import bnShare from "./locales/bn/share.js"
import bnStudio from "./locales/bn/studio.js"
import bnTranscript from "./locales/bn/transcript.js"
import bnWelcome from "./locales/bn/welcome.js"

export const SUPPORTED_LOCALES = ["en", "ru", "uk", "sr-Latn", "sr-Cyrl", "es", "pt", "it", "de", "fr", "pl", "hu", "hi", "bn"] as const
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

const es = {
  activity: esActivity,
  app: esApp,
  chat: esChat,
  errors: esErrors,
  help: esHelp,
  home: esHome,
  library: esLibrary,
  notes: esNotes,
  notifications: esNotifications,
  player: esPlayer,
  search: esSearch,
  settings: esSettings,
  share: esShare,
  studio: esStudio,
  transcript: esTranscript,
  welcome: esWelcome,
}

const pt = {
  activity: ptActivity,
  app: ptApp,
  chat: ptChat,
  errors: ptErrors,
  help: ptHelp,
  home: ptHome,
  library: ptLibrary,
  notes: ptNotes,
  notifications: ptNotifications,
  player: ptPlayer,
  search: ptSearch,
  settings: ptSettings,
  share: ptShare,
  studio: ptStudio,
  transcript: ptTranscript,
  welcome: ptWelcome,
}

const it = {
  activity: itActivity,
  app: itApp,
  chat: itChat,
  errors: itErrors,
  help: itHelp,
  home: itHome,
  library: itLibrary,
  notes: itNotes,
  notifications: itNotifications,
  player: itPlayer,
  search: itSearch,
  settings: itSettings,
  share: itShare,
  studio: itStudio,
  transcript: itTranscript,
  welcome: itWelcome,
}

const de = {
  activity: deActivity,
  app: deApp,
  chat: deChat,
  errors: deErrors,
  help: deHelp,
  home: deHome,
  library: deLibrary,
  notes: deNotes,
  notifications: deNotifications,
  player: dePlayer,
  search: deSearch,
  settings: deSettings,
  share: deShare,
  studio: deStudio,
  transcript: deTranscript,
  welcome: deWelcome,
}

const fr = {
  activity: frActivity,
  app: frApp,
  chat: frChat,
  errors: frErrors,
  help: frHelp,
  home: frHome,
  library: frLibrary,
  notes: frNotes,
  notifications: frNotifications,
  player: frPlayer,
  search: frSearch,
  settings: frSettings,
  share: frShare,
  studio: frStudio,
  transcript: frTranscript,
  welcome: frWelcome,
}

const pl = {
  activity: plActivity,
  app: plApp,
  chat: plChat,
  errors: plErrors,
  help: plHelp,
  home: plHome,
  library: plLibrary,
  notes: plNotes,
  notifications: plNotifications,
  player: plPlayer,
  search: plSearch,
  settings: plSettings,
  share: plShare,
  studio: plStudio,
  transcript: plTranscript,
  welcome: plWelcome,
}

const hu = {
  activity: huActivity,
  app: huApp,
  chat: huChat,
  errors: huErrors,
  help: huHelp,
  home: huHome,
  library: huLibrary,
  notes: huNotes,
  notifications: huNotifications,
  player: huPlayer,
  search: huSearch,
  settings: huSettings,
  share: huShare,
  studio: huStudio,
  transcript: huTranscript,
  welcome: huWelcome,
}

const hi = {
  activity: hiActivity,
  app: hiApp,
  chat: hiChat,
  errors: hiErrors,
  help: hiHelp,
  home: hiHome,
  library: hiLibrary,
  notes: hiNotes,
  notifications: hiNotifications,
  player: hiPlayer,
  search: hiSearch,
  settings: hiSettings,
  share: hiShare,
  studio: hiStudio,
  transcript: hiTranscript,
  welcome: hiWelcome,
}

const bn = {
  activity: bnActivity,
  app: bnApp,
  chat: bnChat,
  errors: bnErrors,
  help: bnHelp,
  home: bnHome,
  library: bnLibrary,
  notes: bnNotes,
  notifications: bnNotifications,
  player: bnPlayer,
  search: bnSearch,
  settings: bnSettings,
  share: bnShare,
  studio: bnStudio,
  transcript: bnTranscript,
  welcome: bnWelcome,
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
  messages: { en, ru, uk, "sr-Latn": srLatn, "sr-Cyrl": srCyrl, es, pt, it, de, fr, pl, hu, hi, bn },
})

export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale
}

export function currentLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale
}

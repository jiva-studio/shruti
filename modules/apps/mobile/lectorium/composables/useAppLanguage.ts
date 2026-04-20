import { type Ref } from "vue"
import { useConfig } from "@lectorium/composables/useConfig.js"

/**
 * The app-wide UI language setting (`settings.appLanguage`). One
 * source of truth for every controller that needs to localise
 * dictionary lookups: buildTrackRow picks author/location/source
 * names via `preferredLanguage = useAppLanguage().value`.
 *
 * Falls back to the browser locale on first launch; the Settings
 * screen binds a chooser to the same `useConfig` key so changes
 * propagate reactively.
 */
export function useAppLanguage(): Ref<string> {
  return useConfig<string>("settings.appLanguage", detectLocale())
}

function detectLocale(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en"
  const short = nav.split("-")[0]
  return short === "ru" ? "ru" : "en"
}

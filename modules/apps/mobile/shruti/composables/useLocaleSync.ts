import { watch, type Ref } from "vue"
import {
  currentLocale,
  setLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@shruti/i18n/index.js"

/**
 * Mirror the persisted UI language ref into the i18n runtime. Called
 * once at the app root so the whole tree (tabs, views, modals)
 * sees the persisted choice the instant `useConfig("settings.appLanguage")`
 * resolves it. `immediate: true` so the first render uses the saved
 * locale instead of the default one.
 *
 * `setLocale` is async (it loads the locale's chunk before flipping) and a
 * watcher cannot await, so this stays fire-and-forget — but not fire-and-
 * forget-the-outcome: a locale whose chunk never arrives used to leave the
 * setting reading one language and the UI showing another, permanently, since
 * the preference had already been persisted (issue #1606). On a failure the
 * setting is rolled back to the language actually on screen, so the picker
 * cannot lie about it across restarts.
 *
 * Silently ignores values not in `SUPPORTED_LOCALES` — the config layer
 * trusts whatever string is in storage, and we don't want a corrupted
 * preference value to blow up i18n at startup.
 */
export function useLocaleSync(appLanguage: Ref<string>): void {
  watch(
    appLanguage,
    (next) => {
      if (!(SUPPORTED_LOCALES as readonly string[]).includes(next)) return
      void setLocale(next as SupportedLocale).then((result) => {
        if (result === "failed" && appLanguage.value === next) {
          appLanguage.value = currentLocale()
        }
      })
    },
    { immediate: true }
  )
}

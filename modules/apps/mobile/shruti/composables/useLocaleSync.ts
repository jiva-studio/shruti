import { watch, type Ref } from "vue"
import {
  currentLocale,
  setLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@shruti/i18n/index.js"
import { storedAppLanguageApplied } from "@shruti/composables/appLanguageApplied.js"

/**
 * Mirror the persisted UI language ref into the i18n runtime. Called
 * once at the app root so the whole tree (tabs, views, modals)
 * sees the persisted choice the instant `useConfig("settings.appLanguage")`
 * resolves it.
 *
 * The immediate run is conditional, and that is the point. `useConfig` seeds
 * its ref synchronously and hydrates from storage a few milliseconds later, so
 * at the moment this is called the ref may still hold the seed rather than the
 * user's choice. When `main.ts` already applied a stored language before mount
 * there is nothing for an immediate run to do except undo it: Russian UI on an
 * English-locale phone rendered `ru`, then `en` in a microtask, then `ru`
 * again when hydration landed — on every cold start (#1742). Skipping it costs
 * nothing, because the language is already on screen and any later change to
 * the ref (hydration, the Settings picker) still fires the watcher normally.
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
    { immediate: !storedAppLanguageApplied() }
  )
}

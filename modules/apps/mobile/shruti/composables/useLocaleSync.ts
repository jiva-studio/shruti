import { watch, type Ref } from "vue"
import { setLocale, SUPPORTED_LOCALES, type SupportedLocale } from "@shruti/i18n/index.js"

/**
 * Mirror the persisted UI language ref into the i18n runtime. Called
 * once at the app root so the whole tree (tabs, views, modals)
 * sees the persisted choice the instant `useConfig("settings.appLanguage")`
 * resolves it. `immediate: true` so the first render uses the saved
 * locale instead of the default one.
 *
 * Silently ignores values not in `SUPPORTED_LOCALES` — the config layer
 * trusts whatever string is in storage, and we don't want a corrupted
 * preference value to blow up i18n at startup.
 */
export function useLocaleSync(appLanguage: Ref<string>): void {
  watch(
    appLanguage,
    (next) => {
      if ((SUPPORTED_LOCALES as readonly string[]).includes(next)) {
        setLocale(next as SupportedLocale)
      }
    },
    { immediate: true }
  )
}

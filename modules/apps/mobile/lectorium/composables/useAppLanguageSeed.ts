import { type Ref } from "vue"
import { detectDeviceLocaleAsync } from "@lectorium/i18n/index.js"
import { APP_LANGUAGE_KEY as KEY } from "@lectorium/composables/useAppLanguage.js"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Seed `settings.appLanguage` from the **native** device locale on first
 * launch. `useAppLanguage` boots the ref with the synchronous
 * `navigator.language` default, but on a Capacitor WebView that can report
 * `en-US` even on a non-English device — which would drive both the UI and
 * the chat answer language (`chatLanguage || appLanguage`) to English. The
 * native Device plugin behind `detectDeviceLocaleAsync` is authoritative.
 *
 * Runs once at the app root, after the locale is already mirrored to i18n.
 * No-op once the user has any persisted UI-language choice, so it never
 * overrides a deliberate selection.
 */
export function useAppLanguageSeed(appLanguage: Ref<string>): void {
  const { preferences } = useLectorium()
  void (async () => {
    if ((await preferences.get(KEY)) !== null) return
    const locale = await detectDeviceLocaleAsync()
    if (appLanguage.value !== locale) appLanguage.value = locale
  })()
}

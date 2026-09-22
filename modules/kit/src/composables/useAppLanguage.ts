import { effectScope, watch, type Ref } from "vue"
import { type UseConfig } from "./useConfig.js"

/** i18n locale handle the language binder reads from / writes to. */
export interface LocaleControl {
  /** Current i18n locale getter (e.g. `() => i18n.global.locale.value`). */
  get(): string
  /** Apply a new i18n locale (e.g. `(l) => { i18n.global.locale.value = l }`). */
  set(locale: string): void
}

/**
 * Binds the app-wide UI language setting to config storage and keeps the
 * supplied i18n locale in sync with it. kit owns neither i18n nor the device
 * locale, so the caller passes:
 *
 *  - `useConfig`    — a binder from {@link createUseConfig}
 *  - `detectLocale` — resolves the default locale on first launch (device locale)
 *  - `locale`       — getter/setter for the active i18n locale
 *
 * Returns the reactive language ref. Mutating it persists the choice and pushes
 * it into i18n; on async hydrate the stored value is likewise applied to i18n.
 */
export function useAppLanguage(
  useConfig: UseConfig,
  detectLocale: () => string,
  locale: LocaleControl,
  key = "settings.appLanguage"
): Ref<string> {
  const language = useConfig<string>(key, detectLocale())

  // Detached scope so the i18n-sync watcher outlives the first consumer's
  // unmount, mirroring useConfig's own persistence watcher.
  effectScope(true).run(() => {
    watch(
      language,
      (next) => {
        if (locale.get() !== next) locale.set(next)
      },
      { immediate: true }
    )
  })

  return language
}

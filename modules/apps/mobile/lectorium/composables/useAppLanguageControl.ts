import { computed, type Ref, type WritableComputedRef } from "vue"
import {
  currentLocale,
  setLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@lectorium/i18n/index.js"

/**
 * The Settings language picker's v-model: a writable view over
 * `settings.appLanguage` whose setter loads the chunk FIRST and persists the
 * choice only once the UI is actually rendering in it.
 *
 * Writing the setting synchronously (what the picker used to do) split the
 * screen in two for the length of the fetch — `appLanguage`'s readers
 * (author/location names, date formats via buildTrackRow) flipped instantly
 * while everything driven by `i18n.global.locale` stayed behind, so Home and
 * Search rendered two languages at once; and when the chunk failed the setting
 * was already persisted, leaving the picker permanently claiming a language the
 * UI never adopted (issue #1606). Deferring the write closes both: the setting
 * and the message set flip in the same tick, and a failure leaves neither moved.
 *
 * `onFailure` is where the caller surfaces that to the user (a toast); the
 * picker simply stays where it was.
 */
export function useAppLanguageControl(
  appLanguage: Ref<string>,
  onFailure?: (locale: string) => void
): WritableComputedRef<string> {
  async function apply(next: string): Promise<void> {
    if (!(SUPPORTED_LOCALES as readonly string[]).includes(next)) return
    // No short-circuit on `next === appLanguage.value`: re-picking the language
    // already showing is exactly how a user cancels a switch they regret, and
    // it only works if `setLocale` is told — that call is what marks the
    // in-flight chunk superseded.
    const result = await setLocale(next as SupportedLocale)
    if (result === "failed") {
      onFailure?.(next)
      return
    }
    // `superseded` means a later pick owns the UI now — that call writes the
    // setting itself, so this one must not overwrite it with a stale value.
    if (result === "applied") appLanguage.value = currentLocale()
  }

  return computed({
    get: () => appLanguage.value,
    set: (next) => {
      void apply(next)
    },
  })
}

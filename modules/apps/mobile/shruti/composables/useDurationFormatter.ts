import { useI18n } from "vue-i18n"
import { formatListeningDuration } from "./formatListeningDuration.js"

/**
 * Vue-i18n-bound wrapper around `formatListeningDuration`. Use inside a
 * component when you need a `(seconds) => string` formatter that picks up
 * the current locale automatically.
 *
 * The pure helper still lives in `formatListeningDuration` so unit tests
 * can drive it with a stub `t` and skip vue-i18n setup.
 */
export function useDurationFormatter(): (seconds: number) => string {
  const { t } = useI18n()
  return (seconds: number) => formatListeningDuration(seconds, t)
}

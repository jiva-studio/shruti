import { computed, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import type { WelcomeViewState } from "../WelcomeView.controller.js"

const STATUS_KEYS: Record<WelcomeViewState, string> = {
  idle: "welcome.status.starting",
  "welcome:checking": "welcome.status.databaseCheck",
  "welcome:downloading": "welcome.status.databaseDownloading",
  "welcome:migrations": "welcome.status.databaseMigrations",
  ready: "welcome.status.starting",
  error: "welcome.status.starting",
}

/**
 * Localised, user-facing status string for a given welcome-view phase.
 * Falls back to the generic "starting" message for terminal states so the
 * UI never shows a raw enum.
 */
export function useStatusMessage(viewState: Ref<WelcomeViewState>): ComputedRef<string> {
  const { t } = useI18n()
  return computed(() => t(STATUS_KEYS[viewState.value] ?? "welcome.status.starting"))
}

import { computed, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import type { WelcomeViewState } from "../WelcomeView.controller.js"

const STATUS_KEYS: Record<WelcomeViewState, string> = {
  "server:probing": "welcome.status.serverProbing",
  "config:downloading": "welcome.status.configDownloading",
  "database:check": "welcome.status.databaseCheck",
  "database:downloading": "welcome.status.databaseDownloading",
  "database:migrations": "welcome.status.databaseMigrations",
  complete: "welcome.status.starting",
  error: "welcome.status.starting",
}

/**
 * Localised, user-facing status string for a given welcome-view state.
 * Falls back to the generic "starting" message for terminal states so the
 * UI never shows a raw enum.
 */
export function useStatusMessage(viewState: Ref<WelcomeViewState>): ComputedRef<string> {
  const { t } = useI18n()
  return computed(() => t(STATUS_KEYS[viewState.value] ?? "welcome.status.starting"))
}

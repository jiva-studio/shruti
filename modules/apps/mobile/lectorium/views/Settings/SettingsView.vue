<template>
  <AppPage :reserve-bottom-space="player.open">
    <SettingsAccountGroup
      :active-server-id="activeServerId"
      :anonymous="auth.anonymous"
      :email="auth.email"
      :name="auth.name"
      :picture="auth.picture"
      :is-subscribed="subscription.isSubscribed"
      :server-items="serverItems"
      @sign-in-anonymous="triggerSignIn"
      @sign-out="auth.signOut"
      @open-paywall="paywall.requestOpen()"
      @manage-subscription="paywall.requestOpen()"
      @delete-account="onDeleteAccountConfirm"
      @preferred-server-change="onPreferredServerChange"
    />

    <SettingsAppearanceGroup
      v-model:app-language="appLanguage"
      v-model:show-player-progress="showPlayerProgress"
      v-model:show-player-on-notes="showPlayerOnNotes"
      v-model:highlight-current-sentence="highlightCurrentSentence"
      v-model:auto-scroll="autoScroll"
      v-model:auto-play-next="autoPlayNext"
      v-model:open-transcript-automatically="openTranscriptAutomatically"
      :language-items="languageItems"
      :is-subscribed="subscription.isSubscribed"
      @request-paywall="paywall.requestOpen($event)"
      @open-track-info="trackInfoOpen = true"
    />

    <TrackInfoDialog
      v-model:config="trackMetaConfig"
      :open="trackInfoOpen"
      @update:open="trackInfoOpen = $event"
    />

    <SettingsSadhanaGroup
      v-model:show-activity-tracker="showActivityTracker"
      v-model:notifications-enabled="notificationsEnabled"
      v-model:notifications-time="notificationsTime"
      :smart-library-subtitle="smartLibrary.subtitle.value"
      @open-smart-library="onSmartLibraryEntry"
    />

    <SmartLibraryDialog
      v-model:target-seconds="autoDownloadTargetSeconds"
      v-model:archive-delay="autoArchiveDelay"
      :open="smartLibraryDialogOpen"
      :filter-summary="smartLibrary.filterSummary.value"
      @update:open="smartLibraryDialogOpen = $event"
      @open-filters="smartLibraryFiltersOpen = true"
    />

    <SearchFiltersSheet
      v-model:filters="smartLibrary.filters.value"
      :open="smartLibraryFiltersOpen"
      :sections="smartLibrary.sections.value"
      :can-reset="smartLibrary.activeFilterCount.value > 0"
      @update:open="smartLibraryFiltersOpen = $event"
      @reset="smartLibrary.reset"
    />

    <SettingsDataGroup @export="onExportDatabase" @import-file="onImportFileSelected" />

    <SettingsHelpGroup @open-help="helpOpen = true" @open-privacy-policy="onOpenPrivacyPolicy" />

    <SettingsDebugGroup
      v-if="debugUnlocked"
      :count="logs.count"
      @view-logs="logsOpen = true"
      @clear-cache="onClearCache"
    />

    <BuildInfo
      :version="version"
      :build-id="buildId"
      :db-number="dbNumber ?? undefined"
      :db-scheme="dbScheme"
      :debug-ids="buildInfoDebugIds"
      @tap="debugTrigger.onTap"
    />

    <HelpDialog v-model:open="helpOpen" />

    <LogsDialog
      v-model:open="logsOpen"
      :entries="logs.entries"
      :count="logs.count"
      @copy="onCopyLogs"
      @clear="logs.clear"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { Clipboard } from "@capacitor/clipboard"
import { useI18n } from "vue-i18n"
import type { BuildInfoId } from "@kit/ui"
import { AppPage, BuildInfo } from "@ui/primitives/index.js"
import {
  LogsDialog,
  SettingsAccountGroup,
  SettingsAppearanceGroup,
  SettingsDataGroup,
  SettingsDebugGroup,
  SettingsHelpGroup,
  SettingsSadhanaGroup,
  SmartLibraryDialog,
  TrackInfoDialog,
} from "@ui/features/settings/index.js"
import { HelpDialog } from "@ui/features/help/index.js"
import { SearchFiltersSheet } from "@ui/features/tracks/search/filters/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { useLogsStore } from "@lectorium/stores/useLogsStore.js"
import { useAnonymousSignInFlow } from "@lectorium/composables/useAnonymousSignInFlow.js"
import { useDebugUnlockTrigger } from "@lectorium/composables/useDebugUnlockTrigger.js"
import { useToast } from "@kit/composables"
import { AccountDeleteError } from "@ports/app/auth.js"
import { useSettingsController } from "./SettingsView.controller.js"

const player = usePlayerStore()
const paywall = usePaywallStore()
const auth = useAuthStore()
const logs = useLogsStore()
const lectorium = useLectorium()
const i18n = useI18n()
const { t } = i18n
const toast = useToast()
const {
  version,
  buildId,
  dbScheme,
  dbNumber,
  appLanguage,
  trackMetaConfig,
  showPlayerProgress,
  showPlayerOnNotes,
  showActivityTracker,
  autoArchiveDelay,
  highlightCurrentSentence,
  autoScroll,
  autoPlayNext,
  openTranscriptAutomatically,
  notificationsEnabled,
  notificationsTime,
  autoDownloadTargetSeconds,
  smartLibrary,
  activeServerId,
  serverItems,
  languageItems,
  onClearCache,
  onExportDatabase,
  onImportFileSelected,
  subscription,
} = useSettingsController()

const debugTrigger = useDebugUnlockTrigger()
const debugUnlocked = debugTrigger.unlocked

// Debug-only identifiers surfaced in the build footer once the hidden
// debug menu is unlocked: RevenueCat customer id + auth-service user id.
const buildInfoDebugIds = computed<BuildInfoId[]>(() => {
  if (!debugUnlocked.value) return []
  const ids: BuildInfoId[] = []
  if (auth.userId) ids.push({ label: "uid", value: auth.userId })
  if (subscription.appUserId) ids.push({ label: "rc", value: subscription.appUserId })
  return ids
})
const { triggerSignIn } = useAnonymousSignInFlow()

const helpOpen = ref(false)
const logsOpen = ref(false)
const trackInfoOpen = ref(false)
const smartLibraryDialogOpen = ref(false)
const smartLibraryFiltersOpen = ref(false)

async function onDeleteAccountConfirm(opts: { wipeLocal: boolean }): Promise<void> {
  // The action sheet that produced this emit has already dismissed
  // itself, so on success there's nothing to close — the Settings
  // screen reactively swaps the signed-in block for the sign-in CTA
  // once the auth store re-bootstraps anonymous. On failure the user
  // is still signed in with local data intact; the toast surfaces the
  // error and they can try again.
  try {
    await auth.deleteAccount(opts)
  } catch (e) {
    console.warn("[settings] delete account failed:", e)
    let key = "settings.account.deleteAccount.errorToast"
    if (e instanceof AccountDeleteError) {
      switch (e.kind) {
        case "already-deleted":
          key = "settings.account.deleteAccount.alreadyDeletedToast"
          break
        case "rate-limited":
          key = "settings.account.deleteAccount.rateLimitedToast"
          break
        case "network":
          key = "settings.account.deleteAccount.networkErrorToast"
          break
        case "server":
          key = "settings.account.deleteAccount.serverErrorToast"
          break
        // "unauthorized" and "unknown" fall through to the generic toast
      }
    }
    await toast.error(t(key))
    return
  }
}

function onPreferredServerChange(newServerId: string): void {
  // Flip the picker; the failover client reads `activeServer.value.id`
  // at every call and the watcher in `initLectorium` persists the new
  // id under `preferredServerId`. No migration, no toast — connectivity
  // is the only thing the picker controls now.
  if (newServerId === lectorium.activeServer.value.id) return
  lectorium.setActiveServerById(newServerId)
}

function onSmartLibraryEntry(): void {
  if (subscription.isSubscribed) smartLibraryDialogOpen.value = true
  else paywall.requestOpen("smartLibrary")
}

async function onCopyLogs(): Promise<void> {
  try {
    await Clipboard.write({ string: logs.asText() })
    await toast.info(t("settings.logs.copied"))
  } catch (e) {
    console.warn("[settings] copy logs failed:", e)
  }
}

function onOpenPrivacyPolicy(): void {
  // Same site / per-locale split as the subscription "Privacy Policy" link
  // (see useSubscriptionBinding.ts) — GitHub Pages from modules/web/policy/.
  const base = "https://akdasa-studios.github.io/lectorium"
  const url = (i18n.locale.value as string) === "ru" ? `${base}/ru.html` : `${base}/`
  // Capacitor's webview opens external schemes in the system browser.
  window.open(url, "_blank")
}
</script>

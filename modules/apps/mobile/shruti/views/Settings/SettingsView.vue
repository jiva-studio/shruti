<template>
  <AppPage :reserve-player-space="player.open">
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
      v-model:open-transcript-automatically="openTranscriptAutomatically"
      :language-items="languageItems"
      :is-subscribed="subscription.isSubscribed"
      @request-paywall="paywall.requestOpen('autoScroll')"
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

    <SettingsDangerGroup v-if="debugUnlocked" @clear-cache="onClearCache" />

    <BuildInfo
      :version="version"
      :build-id="buildId"
      :db-number="dbNumber"
      :db-scheme="dbScheme"
      :app-user-id="debugUnlocked ? subscription.appUserId : undefined"
      :shruti-user-id="debugUnlocked ? (auth.userId ?? undefined) : undefined"
      @tap="debugTrigger.onTap"
    />

    <HelpDialog v-model:open="helpOpen" />
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { AppPage, BuildInfo } from "@ui/primitives/index.js"
import {
  SettingsAccountGroup,
  SettingsAppearanceGroup,
  SettingsDangerGroup,
  SettingsDataGroup,
  SettingsHelpGroup,
  SettingsSadhanaGroup,
  SmartLibraryDialog,
} from "@ui/features/settings/index.js"
import { HelpDialog } from "@ui/features/help/index.js"
import { SearchFiltersSheet } from "@ui/features/tracks/search/filters/index.js"
import { useShruti } from "@shruti/shruti.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { useAnonymousSignInFlow } from "@shruti/composables/useAnonymousSignInFlow.js"
import { useDebugUnlockTrigger } from "@shruti/composables/useDebugUnlockTrigger.js"
import { useToast } from "@shruti/services/useToast.js"
import { AccountDeleteError } from "@infra/auth/capacitor/useCapacitorAuth.js"
import { useSettingsController } from "./SettingsView.controller.js"

const player = usePlayerStore()
const paywall = usePaywallStore()
const auth = useAuthStore()
const shruti = useShruti()
const i18n = useI18n()
const { t } = i18n
const toast = useToast()
const {
  version,
  buildId,
  dbScheme,
  dbNumber,
  appLanguage,
  showPlayerProgress,
  showPlayerOnNotes,
  showActivityTracker,
  autoArchiveDelay,
  highlightCurrentSentence,
  autoScroll,
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
const { triggerSignIn } = useAnonymousSignInFlow()

const helpOpen = ref(false)
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
  // at every call and the watcher in `initShruti` persists the new
  // id under `preferredServerId`. No migration, no toast — connectivity
  // is the only thing the picker controls now.
  if (newServerId === shruti.activeServer.value.id) return
  shruti.setActiveServerById(newServerId)
}

function onSmartLibraryEntry(): void {
  if (subscription.isSubscribed) smartLibraryDialogOpen.value = true
  else paywall.requestOpen("smartLibrary")
}

function onOpenPrivacyPolicy(): void {
  // Same site / per-locale split as the subscription "Privacy Policy" link
  // (see useSubscriptionBinding.ts) — GitHub Pages from modules/web/policy/.
  const base = "https://jiva-studio.github.io/shruti"
  const url = (i18n.locale.value as string) === "ru" ? `${base}/ru.html` : `${base}/`
  // Capacitor's webview opens external schemes in the system browser.
  window.open(url, "_blank")
}
</script>

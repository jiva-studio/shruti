<template>
  <AppPage :reserve-player-space="player.open">
    <SettingsAccountGroup
      v-model:active-server-id="activeServerId"
      :anonymous="auth.anonymous"
      :email="auth.email"
      :name="auth.name"
      :picture="auth.picture"
      :platform="platform"
      :is-subscribed="subscription.isSubscribed"
      :server-items="serverItems"
      @sign-in-google="auth.signInGoogle"
      @sign-in-apple="auth.signInApple"
      @sign-out="auth.signOut"
      @open-paywall="paywall.requestOpen()"
      @manage-subscription="paywall.requestOpen()"
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

    <SettingsHelpGroup @open-help="helpOpen = true" />

    <SettingsDangerGroup
      v-if="debugUnlocked"
      @clear-cache="onClearCache"
      @clear-user-data="onClearUserData"
    />

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
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { useDebugUnlockTrigger } from "@shruti/composables/useDebugUnlockTrigger.js"
import { useShruti } from "@shruti/shruti.js"
import { useSettingsController } from "./SettingsView.controller.js"

const player = usePlayerStore()
const paywall = usePaywallStore()
const auth = useAuthStore()
const platform = useShruti().platform
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
  onClearUserData,
  onExportDatabase,
  onImportFileSelected,
  subscription,
} = useSettingsController()

const debugTrigger = useDebugUnlockTrigger()
const debugUnlocked = debugTrigger.unlocked

const helpOpen = ref(false)
const smartLibraryDialogOpen = ref(false)
const smartLibraryFiltersOpen = ref(false)

function onSmartLibraryEntry(): void {
  if (subscription.isSubscribed) smartLibraryDialogOpen.value = true
  else paywall.requestOpen("smartLibrary")
}
</script>

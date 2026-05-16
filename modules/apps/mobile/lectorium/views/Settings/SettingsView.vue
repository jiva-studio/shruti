<template>
  <AppPage :reserve-player-space="player.open">
    <SettingsSubscriptionGroup
      :available="subscription.available"
      :is-subscribed="subscription.isSubscribed"
      @open-paywall="subscriptionDialogOpen = true"
      @manage="subscription.onManage"
    />

    <SettingsAppearanceGroup
      v-model:app-language="appLanguage"
      v-model:active-server-id="activeServerId"
      v-model:show-player-progress="showPlayerProgress"
      v-model:show-notes-tab="showNotesTab"
      v-model:show-player-on-notes="showPlayerOnNotes"
      v-model:highlight-current-sentence="highlightCurrentSentence"
      v-model:open-transcript-automatically="openTranscriptAutomatically"
      :language-items="languageItems"
      :server-items="serverItems"
    />

    <SettingsSadhanaGroup
      v-model:show-activity-tracker="showActivityTracker"
      v-model:notifications-enabled="notificationsEnabled"
      v-model:notifications-time="notificationsTime"
      :smart-library-subtitle="smartLibrary.subtitle.value"
      @open-smart-library="smartLibraryDialogOpen = true"
    />

    <SmartLibraryDialog
      v-model:target-seconds="autoDownloadTargetSeconds"
      v-model:archive-delay="autoArchiveDelay"
      :open="smartLibraryDialogOpen"
      :filter-summary="smartLibrary.filterSummary.value"
      :is-subscribed="subscription.isSubscribed"
      @update:open="smartLibraryDialogOpen = $event"
      @open-filters="smartLibraryFiltersOpen = true"
      @request-paywall="subscriptionDialogOpen = true"
    />

    <SearchFiltersSheet
      v-model:filters="smartLibrary.filters.value"
      :open="smartLibraryFiltersOpen"
      :sections="smartLibrary.sections.value"
      :can-reset="smartLibrary.activeFilterCount.value > 0"
      @update:open="smartLibraryFiltersOpen = $event"
      @reset="smartLibrary.reset"
    />

    <SubscriptionDialog
      v-model:open="subscriptionDialogOpen"
      :packages="subscription.packages"
      :is-subscribed="subscription.isSubscribed"
      :purchasing="subscription.purchasing"
      :restoring="subscription.restoring"
      :legal-documents="subscription.legalDocuments"
      @subscribe="subscription.onSubscribe"
      @restore="subscription.onRestore"
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
      @tap="debugTrigger.onTap"
    />

    <HelpDialog v-model:open="helpOpen" />
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { AppPage, BuildInfo } from "@ui/primitives/index.js"
import {
  SettingsAppearanceGroup,
  SettingsDangerGroup,
  SettingsDataGroup,
  SettingsHelpGroup,
  SettingsSadhanaGroup,
  SettingsSubscriptionGroup,
  SmartLibraryDialog,
  SubscriptionDialog,
} from "@ui/features/settings/index.js"
import { HelpDialog } from "@ui/features/help/index.js"
import { SearchFiltersSheet } from "@ui/features/tracks/search/filters/index.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useDebugUnlockTrigger } from "@lectorium/composables/useDebugUnlockTrigger.js"
import { useSettingsController } from "./SettingsView.controller.js"

const player = usePlayerStore()
const {
  version,
  buildId,
  dbScheme,
  dbNumber,
  appLanguage,
  showPlayerProgress,
  showNotesTab,
  showPlayerOnNotes,
  showActivityTracker,
  autoArchiveDelay,
  highlightCurrentSentence,
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
const subscriptionDialogOpen = ref(false)
</script>

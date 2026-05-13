<template>
  <AppPage :reserve-player-space="player.open">
    <SettingsAppearanceGroup
      v-model:app-language="appLanguage"
      v-model:active-server-id="activeServerId"
      v-model:show-player-progress="showPlayerProgress"
      v-model:show-notes-tab="showNotesTab"
      v-model:highlight-current-sentence="highlightCurrentSentence"
      v-model:open-transcript-automatically="openTranscriptAutomatically"
      :language-items="languageItems"
      :server-items="serverItems"
    />

    <SettingsSadhanaGroup
      v-model:show-activity-tracker="showActivityTracker"
      v-model:notifications-enabled="notificationsEnabled"
      v-model:notifications-time="notificationsTime"
    />

    <SettingsDataGroup @export="onExportDatabase" @import-file="onImportFileSelected" />

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
      @tap="debugTrigger.onTap"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { AppPage, BuildInfo } from "@ui/primitives/index.js"
import {
  SettingsAppearanceGroup,
  SettingsDangerGroup,
  SettingsDataGroup,
  SettingsSadhanaGroup,
} from "@ui/features/settings/index.js"
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
  showActivityTracker,
  highlightCurrentSentence,
  openTranscriptAutomatically,
  notificationsEnabled,
  notificationsTime,
  activeServerId,
  serverItems,
  languageItems,
  onClearCache,
  onClearUserData,
  onExportDatabase,
  onImportFileSelected,
} = useSettingsController()

const debugTrigger = useDebugUnlockTrigger()
const debugUnlocked = debugTrigger.unlocked
</script>

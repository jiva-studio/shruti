<template>
  <AppPage :player-open="player.open">
    <!-- Appearance -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.appearance') }}</IonLabel>
    </IonListHeader>
    <AppLanguageSettingsItem
      v-model="appLanguage"
      :items="languageItems"
    />
    <ServerSettingsItem
      v-model="activeServerId"
      :items="serverItems"
    />
    <ShowPlayerProgressSettingsItem v-model="showPlayerProgress" />
    <ShowNotesTabSettingsItem v-model="showNotesTab" />
    <HighlightCurrentSentenceSettingsItem v-model="highlightCurrentSentence" />
    <OpenTranscriptAutomaticallySettingsItem v-model="openTranscriptAutomatically" />

    <!-- Sadhana -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.sadhana') }}</IonLabel>
    </IonListHeader>
    <NotificationsEnabledSettingsItem v-model="notificationsEnabled" />
    <DailyNotificationsTimeSettingsItem
      v-if="notificationsEnabled"
      v-model="notificationsTime"
    />

    <!-- Debug (hidden until unlocked via 5 taps on the build info) -->
    <template v-if="debugUnlocked">
      <IonListHeader>
        <IonLabel>{{ $t('settings.groups.danger') }}</IonLabel>
      </IonListHeader>
      <IonItem button :detail="false" lines="none" @click="onClearCache">
        <IonLabel color="danger">{{ $t("settings.danger.clearCache") }}</IonLabel>
      </IonItem>
      <IonItem button :detail="false" lines="none" @click="onClearUserData">
        <IonLabel color="danger">{{ $t("settings.danger.clearUserData") }}</IonLabel>
      </IonItem>
    </template>

    <!-- Build info — tap 5× to unlock debug -->
    <p
      class="build-info"
      @click="onVersionTap"
    >
      v{{ version }} ({{ buildId }})
      <span class="build-info-db">
        DB {{ contentDbFile ?? "—" }} · scheme {{ dbScheme }} · {{ activeServer.name }}
      </span>
    </p>
  </AppPage>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { AppPage } from "@ui/primitives/index.js"
import {
  AppLanguageSettingsItem,
  DailyNotificationsTimeSettingsItem,
  HighlightCurrentSentenceSettingsItem,
  NotificationsEnabledSettingsItem,
  OpenTranscriptAutomaticallySettingsItem,
  ServerSettingsItem,
  ShowNotesTabSettingsItem,
  ShowPlayerProgressSettingsItem,
} from "@ui/features/settings/index.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useSettingsController } from "./SettingsView.controller.js"

const player = usePlayerStore()
const {
  version,
  buildId,
  dbScheme,
  activeServer,
  contentDbFile,
  debugUnlocked,
  onVersionTap,
  appLanguage,
  showPlayerProgress,
  showNotesTab,
  highlightCurrentSentence,
  openTranscriptAutomatically,
  notificationsEnabled,
  notificationsTime,
  activeServerId,
  serverItems,
  languageItems,
  onClearCache,
  onClearUserData,
} = useSettingsController()
</script>

<style scoped>
.build-info {
  font-size: 0.75em;
  color: var(--ion-color-medium);
  text-align: center;
  margin-top: 24px;
  padding: 12px 16px calc(96px + env(safe-area-inset-bottom, 0px));
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: opacity 120ms ease;
}

.build-info:active {
  opacity: 0.5;
}

.build-info-db {
  display: block;
  margin-top: 2px;
  opacity: 0.75;
}
</style>

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
    <template v-if="debug.unlocked">
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
import { computed, onMounted, ref, watch } from "vue"
import { IonItem, IonLabel, IonList, IonListHeader, toastController } from "@ionic/vue"
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
import { useShruti } from "@shruti/shruti.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { applyDailyReminder } from "@shruti/composables/useDailyReminder.js"
import { useDebugStore } from "@shruti/stores/useDebugStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import type { Language } from "@lib/domain/language.js"

declare const __APP_VERSION__: string
declare const __BUILD_ID__: string
declare const __DB_SCHEME__: number

const app = useShruti()
const player = usePlayerStore()
const debug = useDebugStore()

const version = __APP_VERSION__
const buildId = __BUILD_ID__
const dbScheme = __DB_SCHEME__
const activeServer = computed(() => app.activeServer.value)
const contentDbFile = computed(() => app.contentDbFile.value)

/* Config */
const appLanguage = useConfig<string>("settings.appLanguage", "en")
const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)
const openTranscriptAutomatically = useConfig<boolean>(
  "settings.openTranscriptAutomatically",
  false
)
const showPlayerProgress = useConfig<boolean>("settings.showPlayerProgress", false)
const showNotesTab = useConfig<boolean>("settings.notes.showTab", true)
const notificationsEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
const notificationsTime = useConfig<[number, number] | undefined>(
  "settings.notificationsTime",
  [9, 0]
)

/* Active CDN */
const activeServerId = ref<string>(app.activeServer.value.id)
const serverItems = app.appConfig.servers.map((s) => ({ id: s.id, title: s.name }))

watch(activeServerId, (next) => {
  const server = app.appConfig.servers.find((s) => s.id === next)
  if (server) app.setActiveServer(server)
})

/* Language chooser source list */
const languageItems = ref<{ id: string; title: string }[]>([])

onMounted(async () => {
  try {
    const langs: readonly Language[] = await app.repositories().languages.listAll()
    languageItems.value = langs.map((l) => ({ id: l.code, title: l.fullName }))
  } catch {
    languageItems.value = [
      { id: "en", title: "English" },
      { id: "ru", title: "Русский" },
    ]
  }
})

/* Notifications scheduler */
watch(
  [notificationsEnabled, notificationsTime],
  ([enabled, time]) => {
    const hhmm = time ? `${pad(time[0])}:${pad(time[1])}` : "09:00"
    void applyDailyReminder(
      { enabled, time: hhmm },
      { notifications: app.notifications }
    )
  },
  { immediate: true }
)

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}

/* Debug unlock */
async function onVersionTap(): Promise<void> {
  if (debug.registerUnlockTap()) {
    const toast = await toastController.create({
      message: "Debug mode enabled",
      duration: 1500,
      position: "top",
      color: "success",
    })
    await toast.present()
  }
}

/* Danger handlers */
async function onClearCache(): Promise<void> {
  await app.filesStorage.clearAll()
}

async function onClearUserData(): Promise<void> {
  const userDb = app.databases.user
  if (!userDb) return
  await userDb.execute("DELETE FROM notes")
  await userDb.execute("DELETE FROM playlist_items")
  await userDb.execute("DELETE FROM media_items")
  await userDb.save()
  await app.preferences.remove("search.filters.v2")
}
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

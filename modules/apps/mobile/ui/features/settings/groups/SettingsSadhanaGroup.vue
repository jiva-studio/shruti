<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.sadhana") }}</IonLabel>
  </IonListHeader>
  <ShowActivityTrackerSettingsItem v-model="showActivityTracker" />
  <NotificationsEnabledSettingsItem v-model="notificationsEnabled" />
  <DailyNotificationsTimeSettingsItem v-if="notificationsEnabled" v-model="notificationsTime" />
  <AutoDownloadTargetSettingsItem v-model="autoDownloadTargetSeconds" />
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import AutoDownloadTargetSettingsItem from "../AutoDownloadTargetSettingsItem.vue"
import DailyNotificationsTimeSettingsItem from "../DailyNotificationsTimeSettingsItem.vue"
import NotificationsEnabledSettingsItem from "../NotificationsEnabledSettingsItem.vue"
import ShowActivityTrackerSettingsItem from "../ShowActivityTrackerSettingsItem.vue"

const showActivityTracker = defineModel<boolean>("showActivityTracker", { required: true })
const notificationsEnabled = defineModel<boolean>("notificationsEnabled", { required: true })
const notificationsTime = defineModel<[number, number] | undefined>("notificationsTime", {
  required: true,
})
const autoDownloadTargetSeconds = defineModel<number>("autoDownloadTargetSeconds", {
  required: true,
})
</script>

<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.sadhana") }}</IonLabel>
  </IonListHeader>
  <ShowActivityTrackerSettingsItem v-model="showActivityTracker" />
  <AutoArchiveDelaySettingsItem v-model="autoArchiveDelay" />
  <NotificationsEnabledSettingsItem v-model="notificationsEnabled" />
  <DailyNotificationsTimeSettingsItem v-if="notificationsEnabled" v-model="notificationsTime" />
  <AutoDownloadTargetSettingsItem
    :subtitle="autoDownloadSubtitle"
    @click="emit('open-auto-download-config')"
  />
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import AutoArchiveDelaySettingsItem, {
  type AutoArchiveDelay,
} from "../AutoArchiveDelaySettingsItem.vue"
import AutoDownloadTargetSettingsItem from "../AutoDownloadTargetSettingsItem.vue"
import DailyNotificationsTimeSettingsItem from "../DailyNotificationsTimeSettingsItem.vue"
import NotificationsEnabledSettingsItem from "../NotificationsEnabledSettingsItem.vue"
import ShowActivityTrackerSettingsItem from "../ShowActivityTrackerSettingsItem.vue"

const showActivityTracker = defineModel<boolean>("showActivityTracker", { required: true })
const autoArchiveDelay = defineModel<AutoArchiveDelay>("autoArchiveDelay", { required: true })
const notificationsEnabled = defineModel<boolean>("notificationsEnabled", { required: true })
const notificationsTime = defineModel<[number, number] | undefined>("notificationsTime", {
  required: true,
})

defineProps<{ autoDownloadSubtitle: string }>()

const emit = defineEmits<{ "open-auto-download-config": [] }>()
</script>

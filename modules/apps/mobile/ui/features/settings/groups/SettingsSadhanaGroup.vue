<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.sadhana") }}</IonLabel>
  </IonListHeader>
  <NotificationsEnabledSettingsItem v-model="notificationsEnabled" />
  <DailyNotificationsTimeSettingsItem v-if="notificationsEnabled" v-model="notificationsTime" />
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import DailyNotificationsTimeSettingsItem from "../DailyNotificationsTimeSettingsItem.vue"
import NotificationsEnabledSettingsItem from "../NotificationsEnabledSettingsItem.vue"

const notificationsEnabled = defineModel<boolean>("notificationsEnabled", { required: true })
const notificationsTime = defineModel<[number, number] | undefined>("notificationsTime", {
  required: true,
})
</script>

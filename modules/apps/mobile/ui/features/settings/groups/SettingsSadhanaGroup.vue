<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.sadhana") }}</IonLabel>
  </IonListHeader>

  <!-- Plain toggles use kit's SettingsToggleItem shell; app owns icon + text. -->
  <SettingsToggleItem
    v-model:checked="showActivityTracker"
    :title="$t('settings.activityTracker.show.title')"
    :subtitle="$t('settings.activityTracker.show.description')"
  >
    <template #icon>
      <IconChip><FlameIcon /></IconChip>
    </template>
  </SettingsToggleItem>

  <SettingsToggleItem
    v-model:checked="notificationsEnabled"
    :title="$t('settings.notifications.enabled.title')"
    :subtitle="$t('settings.notifications.enabled.description')"
  >
    <template #icon>
      <IconChip><BellIcon /></IconChip>
    </template>
  </SettingsToggleItem>

  <DailyNotificationsTimeSettingsItem v-if="notificationsEnabled" v-model="notificationsTime" />
  <DailyWisdomSettingsItem
    v-if="notificationsEnabled"
    :subtitle="dailyWisdomSubtitle"
    @click="emit('open-daily-wisdom')"
  />
  <SmartLibrarySettingsItem :subtitle="smartLibrarySubtitle" @click="emit('open-smart-library')" />
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsToggleItem } from "@kit/ui"
import { BellIcon, FlameIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"
import DailyNotificationsTimeSettingsItem from "../DailyNotificationsTimeSettingsItem.vue"
import DailyWisdomSettingsItem from "../DailyWisdomSettingsItem.vue"
import SmartLibrarySettingsItem from "../SmartLibrarySettingsItem.vue"

const showActivityTracker = defineModel<boolean>("showActivityTracker", { required: true })
const notificationsEnabled = defineModel<boolean>("notificationsEnabled", { required: true })
const notificationsTime = defineModel<[number, number] | undefined>("notificationsTime", {
  required: true,
})

defineProps<{ smartLibrarySubtitle: string; dailyWisdomSubtitle: string }>()

const emit = defineEmits<{ "open-smart-library": []; "open-daily-wisdom": [] }>()
</script>

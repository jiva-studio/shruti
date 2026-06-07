<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.debug") }}</IonLabel>
  </IonListHeader>

  <SettingsActionItem
    :title="$t('settings.debug.viewLogs.title')"
    :subtitle="$t('settings.debug.viewLogs.description', { count })"
    @activate="emit('viewLogs')"
  >
    <template #icon>
      <IconChip><TranscriptIcon /></IconChip>
    </template>
  </SettingsActionItem>
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsActionItem } from "@kit/ui"
import { TranscriptIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

defineProps<{
  /** Number of buffered log lines — shown in the subtitle. */
  count: number
}>()

const emit = defineEmits<{
  viewLogs: []
}>()
</script>

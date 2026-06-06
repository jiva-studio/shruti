<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.danger") }}</IonLabel>
  </IonListHeader>

  <SettingsActionItem
    danger
    :title="$t('settings.danger.clearCache.title')"
    :subtitle="$t('settings.danger.clearCache.description')"
    @activate="emit('clearCache')"
  >
    <template #icon>
      <IconChip danger><ArchiveIcon /></IconChip>
    </template>
  </SettingsActionItem>
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsActionItem } from "@kit/ui"
import { ArchiveIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const emit = defineEmits<{
  clearCache: []
}>()
</script>

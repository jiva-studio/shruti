<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.danger") }}</IonLabel>
  </IonListHeader>

  <IonItem button :detail="false" lines="none" @click="emit('clearCache')">
    <IconChip slot="start" danger>
      <ArchiveIcon />
    </IconChip>
    <IonLabel class="ion-text-nowrap settings-danger-label">
      <h2>{{ $t("settings.danger.clearCache.title") }}</h2>
      <p>{{ $t("settings.danger.clearCache.description") }}</p>
    </IonLabel>
  </IonItem>

  <IonItem button :detail="false" lines="none" @click="emit('clearUserData')">
    <IconChip slot="start" danger>
      <TrashIcon />
    </IconChip>
    <IonLabel class="ion-text-nowrap settings-danger-label">
      <h2>{{ $t("settings.danger.clearUserData.title") }}</h2>
      <p>{{ $t("settings.danger.clearUserData.description") }}</p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { ArchiveIcon, TrashIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const emit = defineEmits<{
  clearCache: []
  clearUserData: []
}>()
</script>

<style scoped>
.settings-danger-label :deep(h2) {
  color: var(--ion-color-danger);
}
</style>

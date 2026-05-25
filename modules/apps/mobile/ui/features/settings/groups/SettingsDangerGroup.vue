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
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { ArchiveIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const emit = defineEmits<{
  clearCache: []
}>()
</script>

<style scoped>
.settings-danger-label :deep(h2) {
  color: var(--ion-color-danger);
}
</style>

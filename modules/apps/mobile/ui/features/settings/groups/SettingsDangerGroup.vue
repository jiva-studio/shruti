<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.danger") }}</IonLabel>
  </IonListHeader>

  <IonItem button :detail="false" lines="none" @click="emit('clearCache')">
    <div slot="start" class="settings-item-icon settings-item-icon--danger">
      <ArchiveIcon />
    </div>
    <IonLabel class="ion-text-nowrap settings-danger-label">
      <h2>{{ $t("settings.danger.clearCache.title") }}</h2>
      <p>{{ $t("settings.danger.clearCache.description") }}</p>
    </IonLabel>
  </IonItem>

  <IonItem button :detail="false" lines="none" @click="emit('clearUserData')">
    <div slot="start" class="settings-item-icon settings-item-icon--danger">
      <TrashIcon />
    </div>
    <IonLabel class="ion-text-nowrap settings-danger-label">
      <h2>{{ $t("settings.danger.clearUserData.title") }}</h2>
      <p>{{ $t("settings.danger.clearUserData.description") }}</p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { ArchiveIcon, TrashIcon } from "@ui/icons/index.js"

const emit = defineEmits<{
  clearCache: []
  clearUserData: []
}>()
</script>

<style scoped>
/* Danger variant of the standard settings icon tile. Mirrors the layout
 * of the normal `.settings-item-icon` but swaps the neutral warm surface
 * for a warm-red tint and red glyph so the row visually matches its
 * siblings while still signalling a destructive action. */
.settings-item-icon--danger {
  background-color: rgba(var(--ion-color-danger-rgb), 0.12);
  color: var(--ion-color-danger);
}

/* Title in danger red; description stays in the default muted tone so
 * both rows still read like the rest of the settings list. */
.settings-danger-label :deep(h2) {
  color: var(--ion-color-danger);
}
</style>

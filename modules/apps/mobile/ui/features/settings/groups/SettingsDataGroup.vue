<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.data") }}</IonLabel>
  </IonListHeader>

  <IonItem button :detail="false" lines="none" @click="emit('export')">
    <IconChip slot="start">
      <DatabaseExportIcon />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.data.export.title") }}</h2>
      <p>{{ $t("settings.data.export.description") }}</p>
    </IonLabel>
  </IonItem>

  <IonItem button :detail="false" lines="none" @click="onImportClick">
    <IconChip slot="start">
      <DatabaseImportIcon />
    </IconChip>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.data.import.title") }}</h2>
      <p>{{ $t("settings.data.import.description") }}</p>
    </IonLabel>
  </IonItem>

  <input ref="fileInput" type="file" accept=".db" style="display: none" @change="onFileChange" />
</template>

<script setup lang="ts">
import { ref } from "vue"
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { DatabaseExportIcon, DatabaseImportIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const emit = defineEmits<{
  export: []
  importFile: [File]
}>()

const fileInput = ref<HTMLInputElement | null>(null)

function onImportClick(): void {
  fileInput.value?.click()
}

function onFileChange(event: Event): void {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  emit("importFile", file)
  // Reset so selecting the same file twice still fires `change`.
  target.value = ""
}
</script>

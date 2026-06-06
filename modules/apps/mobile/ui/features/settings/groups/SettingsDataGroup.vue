<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.data") }}</IonLabel>
  </IonListHeader>

  <SettingsActionItem
    :title="$t('settings.data.export.title')"
    :subtitle="$t('settings.data.export.description')"
    @activate="emit('export')"
  >
    <template #icon>
      <IconChip><DatabaseExportIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <SettingsActionItem
    :title="$t('settings.data.import.title')"
    :subtitle="$t('settings.data.import.description')"
    @activate="onImportClick"
  >
    <template #icon>
      <IconChip><DatabaseImportIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <input ref="fileInput" type="file" accept=".db" style="display: none" @change="onFileChange" />
</template>

<script setup lang="ts">
import { ref } from "vue"
import { IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsActionItem } from "@kit/ui"
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

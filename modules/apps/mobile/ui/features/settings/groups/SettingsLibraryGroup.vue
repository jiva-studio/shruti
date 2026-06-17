<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.library") }}</IonLabel>
  </IonListHeader>

  <LibraryLanguageSettingsItem
    :items="languageItems"
    :selected="selected"
    @update:selected="emit('update:selected', $event)"
  />
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import LibraryLanguageSettingsItem from "../LibraryLanguageSettingsItem.vue"

interface SelectorItem {
  id: string
  title: string
}

// The content languages lectures are shown in — a single tappable row that
// opens a multi-select checkbox dialog. The picker enforces "at least one".
defineProps<{
  languageItems: SelectorItem[]
  selected: string[]
}>()

const emit = defineEmits<{ "update:selected": [string[]] }>()
</script>

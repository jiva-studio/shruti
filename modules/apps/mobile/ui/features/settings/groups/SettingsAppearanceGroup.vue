<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.appearance") }}</IonLabel>
  </IonListHeader>
  <AppLanguageSettingsItem v-model="appLanguage" :items="languageItems" />
  <ServerSettingsItem v-model="activeServerId" :items="serverItems" />
  <ShowPlayerProgressSettingsItem v-model="showPlayerProgress" />
  <ShowNotesTabSettingsItem v-model="showNotesTab" />
  <ShowPlayerOnNotesSettingsItem v-if="showNotesTab" v-model="showPlayerOnNotes" />
  <HighlightCurrentSentenceSettingsItem v-model="highlightCurrentSentence" />
  <OpenTranscriptAutomaticallySettingsItem v-model="openTranscriptAutomatically" />
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import AppLanguageSettingsItem from "../AppLanguageSettingsItem.vue"
import HighlightCurrentSentenceSettingsItem from "../HighlightCurrentSentenceSettingsItem.vue"
import OpenTranscriptAutomaticallySettingsItem from "../OpenTranscriptAutomaticallySettingsItem.vue"
import ServerSettingsItem from "../ServerSettingsItem.vue"
import ShowNotesTabSettingsItem from "../ShowNotesTabSettingsItem.vue"
import ShowPlayerOnNotesSettingsItem from "../ShowPlayerOnNotesSettingsItem.vue"
import ShowPlayerProgressSettingsItem from "../ShowPlayerProgressSettingsItem.vue"

interface SelectorItem {
  id: string
  title: string
}

defineProps<{
  languageItems: SelectorItem[]
  serverItems: SelectorItem[]
}>()

const appLanguage = defineModel<string>("appLanguage", { required: true })
const activeServerId = defineModel<string>("activeServerId", { required: true })
const showPlayerProgress = defineModel<boolean>("showPlayerProgress", { required: true })
const showNotesTab = defineModel<boolean>("showNotesTab", { required: true })
const showPlayerOnNotes = defineModel<boolean>("showPlayerOnNotes", { required: true })
const highlightCurrentSentence = defineModel<boolean>("highlightCurrentSentence", {
  required: true,
})
const openTranscriptAutomatically = defineModel<boolean>("openTranscriptAutomatically", {
  required: true,
})
</script>

<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.appearance") }}</IonLabel>
  </IonListHeader>
  <AppLanguageSettingsItem v-model="appLanguage" :items="languageItems" />
  <ShowPlayerProgressSettingsItem v-model="showPlayerProgress" />
  <ShowPlayerOnNotesSettingsItem v-model="showPlayerOnNotes" />
  <HighlightCurrentSentenceSettingsItem v-model="highlightCurrentSentence" />
  <AutomaticScrollSettingsItem
    v-model="autoScroll"
    :is-subscribed="isSubscribed"
    @request-paywall="emit('request-paywall')"
  />
  <OpenTranscriptAutomaticallySettingsItem v-model="openTranscriptAutomatically" />
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import AppLanguageSettingsItem from "../AppLanguageSettingsItem.vue"
import AutomaticScrollSettingsItem from "../AutomaticScrollSettingsItem.vue"
import HighlightCurrentSentenceSettingsItem from "../HighlightCurrentSentenceSettingsItem.vue"
import OpenTranscriptAutomaticallySettingsItem from "../OpenTranscriptAutomaticallySettingsItem.vue"
import ShowPlayerOnNotesSettingsItem from "../ShowPlayerOnNotesSettingsItem.vue"
import ShowPlayerProgressSettingsItem from "../ShowPlayerProgressSettingsItem.vue"

interface SelectorItem {
  id: string
  title: string
}

defineProps<{
  languageItems: SelectorItem[]
  isSubscribed: boolean
}>()

const emit = defineEmits<{ "request-paywall": [] }>()

const appLanguage = defineModel<string>("appLanguage", { required: true })
const showPlayerProgress = defineModel<boolean>("showPlayerProgress", { required: true })
const showPlayerOnNotes = defineModel<boolean>("showPlayerOnNotes", { required: true })
const highlightCurrentSentence = defineModel<boolean>("highlightCurrentSentence", {
  required: true,
})
const autoScroll = defineModel<boolean>("autoScroll", { required: true })
const openTranscriptAutomatically = defineModel<boolean>("openTranscriptAutomatically", {
  required: true,
})
</script>

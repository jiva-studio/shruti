<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.appearance") }}</IonLabel>
  </IonListHeader>
  <AppLanguageSettingsItem v-model="appLanguage" :items="languageItems" />
  <ShowPlayerProgressSettingsItem v-model="showPlayerProgress" />
  <ShowPlayerOnNotesSettingsItem v-model="showPlayerOnNotes" />
  <HighlightCurrentSentenceSettingsItem v-model="highlightCurrentSentence" />
  <OpenTranscriptAutomaticallySettingsItem v-model="openTranscriptAutomatically" />
  <!-- Pro items grouped at the bottom — keeps the plain toggles together
       and the paywalled entries visually set apart. Track Info sits last. -->
  <AutomaticScrollSettingsItem
    v-model="autoScroll"
    :is-subscribed="isSubscribed"
    @request-paywall="emit('request-paywall', 'autoScroll')"
  />
  <TrackInfoSettingsItem
    :is-subscribed="isSubscribed"
    @open="emit('open-track-info')"
    @request-paywall="emit('request-paywall', 'trackInfo')"
  />
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import AppLanguageSettingsItem from "../AppLanguageSettingsItem.vue"
import TrackInfoSettingsItem from "../TrackInfoSettingsItem.vue"
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

// Paywall feature keys this group surfaces — a local literal union so we
// don't cross-import the subscription feature into this one. Both are
// valid SubscriptionFeatureKey values at the SettingsView call site.
const emit = defineEmits<{
  "request-paywall": [feature: "autoScroll" | "trackInfo"]
  "open-track-info": []
}>()

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

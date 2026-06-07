<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.appearance") }}</IonLabel>
  </IonListHeader>
  <AppLanguageSettingsItem v-model="appLanguage" :items="languageItems" />

  <!-- Plain appearance toggles use kit's generic SettingsToggleItem shell
       (IonItem + IonLabel + IonToggle). App owns the icon, i18n text and the
       bound store value; kit owns the row markup. -->
  <SettingsToggleItem
    v-model:checked="showPlayerProgress"
    :title="$t('settings.player.showProgress.title')"
    :subtitle="$t('settings.player.showProgress.description')"
  >
    <template #icon>
      <IconChip><ClockIcon /></IconChip>
    </template>
  </SettingsToggleItem>

  <SettingsToggleItem
    v-model:checked="showPlayerOnNotes"
    :title="$t('settings.notes.showPlayer.title')"
    :subtitle="$t('settings.notes.showPlayer.description')"
  >
    <template #icon>
      <IconChip><IconPlayerPlayFilled :size="22" /></IconChip>
    </template>
  </SettingsToggleItem>

  <SettingsToggleItem
    v-model:checked="highlightCurrentSentence"
    :title="$t('settings.transcript.highlightCurrentSentence.title')"
    :subtitle="$t('settings.transcript.highlightCurrentSentence.description')"
  >
    <template #icon>
      <IconChip><HighlightTextIcon /></IconChip>
    </template>
  </SettingsToggleItem>

  <SettingsToggleItem
    v-model:checked="openTranscriptAutomatically"
    :title="$t('settings.transcript.showAutomatically.title')"
    :subtitle="$t('settings.transcript.showAutomatically.description')"
  >
    <template #icon>
      <IconChip><AnnotationIcon /></IconChip>
    </template>
  </SettingsToggleItem>

  <!-- Pro items grouped at the bottom — keeps the plain toggles together
       and the paywalled entries visually set apart. Track Info sits last.
       These keep bespoke components: AutomaticScroll vetoes flips behind the
       paywall (kit toggle is veto-able but the ProBadge + effective-checked
       remount logic is app domain); TrackInfo opens an app dialog. -->
  <AutoPlayNextSettingsItem
    v-model="autoPlayNext"
    :is-subscribed="isSubscribed"
    @request-paywall="emit('request-paywall', 'continuousPlayback')"
  />
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
import { SettingsToggleItem } from "@kit/ui"
import { IconPlayerPlayFilled } from "@tabler/icons-vue"
import { ClockIcon, HighlightTextIcon, AnnotationIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"
import AppLanguageSettingsItem from "../AppLanguageSettingsItem.vue"
import TrackInfoSettingsItem from "../TrackInfoSettingsItem.vue"
import AutomaticScrollSettingsItem from "../AutomaticScrollSettingsItem.vue"
import AutoPlayNextSettingsItem from "../AutoPlayNextSettingsItem.vue"

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
  "request-paywall": [feature: "autoScroll" | "trackInfo" | "continuousPlayback"]
  "open-track-info": []
}>()

const appLanguage = defineModel<string>("appLanguage", { required: true })
const showPlayerProgress = defineModel<boolean>("showPlayerProgress", { required: true })
const showPlayerOnNotes = defineModel<boolean>("showPlayerOnNotes", { required: true })
const highlightCurrentSentence = defineModel<boolean>("highlightCurrentSentence", {
  required: true,
})
const autoScroll = defineModel<boolean>("autoScroll", { required: true })
const autoPlayNext = defineModel<boolean>("autoPlayNext", { required: true })
const openTranscriptAutomatically = defineModel<boolean>("openTranscriptAutomatically", {
  required: true,
})
</script>

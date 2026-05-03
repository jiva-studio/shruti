<template>
  <IonModal :is-open="open" class="transcript-dialog" @did-dismiss="open = false">
    <IonContent>
      <TranscriptDialogHeader :title="title" :author="author" />

      <LanguageSelector
        v-if="availableLanguages.length > 1"
        v-model:active="activeLanguages"
        :languages="availableLanguages"
        :allow-multiple="allowMultipleLanguages"
      />

      <TranscriptStatus
        :state="statusState"
        :error-message="errorMessage"
        :empty-message="$t('transcript.noneAvailable')"
      />
      <TranscriptText
        v-if="statusState === null"
        class="transcript-text"
        :groups="blockGroups"
        :position="position"
        :duration="duration"
        :display-speaker-icons="allowMultipleLanguages"
        :should-highlight-current-sentence="
          enableActiveProminence !== false && shouldHighlightCurrentSentence
        "
        :enable-active-prominence="enableActiveProminence !== false"
        @seek="(pos) => emit('seek', pos)"
        @text-selected="onTextSelected"
        @pick-start="emit('pickStart')"
      />

      <TranscriptSelectionPopover
        :selection="lastTextSelectedEvent"
        @action="onSelectionAction"
        @dismissed="onSelectionDismissed"
      />

      <SpeakerFloatingChip />
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { IonContent, IonModal } from "@ionic/vue"
import LanguageSelector from "./LanguageSelector.vue"
import SpeakerFloatingChip from "./SpeakerFloatingChip.vue"
import TranscriptDialogHeader from "./TranscriptDialogHeader.vue"
import TranscriptStatus from "./TranscriptStatus.vue"
import TranscriptSelectionPopover, { type SelectionAction } from "./TranscriptSelectionPopover.vue"
import TranscriptText, { type TextSelectedEvent } from "./TranscriptText.vue"
import type { UiTranscriptBlocksGroup, UiTranscriptLanguage } from "./types.js"

export type SelectionActionEvent = Pick<TextSelectedEvent, "timeStart" | "timeEnd" | "text"> & {
  action: SelectionAction
}

const props = defineProps<{
  blockGroups: readonly UiTranscriptBlocksGroup[]
  availableLanguages: readonly UiTranscriptLanguage[]
  title: string
  author: string
  position: number
  duration: number
  allowMultipleLanguages: boolean
  shouldHighlightCurrentSentence: boolean
  /** True while the transcript is being fetched. Shows a spinner. */
  isLoading?: boolean
  /** Non-null when the transcript fetch failed. Shows the error text. */
  errorMessage?: string | null
  /** True after hydration when the track has no advertised transcripts. */
  hasNoTranscripts?: boolean
  /**
   * When false, the active-paragraph prompter effect (scale-up of the
   * current group, scale-down + fade of the rest) is suppressed. Use
   * for preview-style opens where the dialog isn't tied to live
   * playback and `position` stays at 0.
   */
  enableActiveProminence?: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  selectionAction: [action: SelectionActionEvent]
  selectionDismissed: []
  /** Long-press on a selectable block — controller fires platform haptics. */
  pickStart: []
}>()

const open = defineModel<boolean>("open", { default: false, required: true })
const activeLanguages = defineModel<string[]>("activeLanguages", {
  default: [] as string[],
  required: true,
})

const statusState = computed<"loading" | "error" | "empty" | null>(() => {
  if (props.isLoading) return "loading"
  if (props.errorMessage) return "error"
  if (props.hasNoTranscripts) return "empty"
  return null
})

const lastTextSelectedEvent = ref<TextSelectedEvent>()

function onTextSelected(event: TextSelectedEvent): void {
  lastTextSelectedEvent.value = event
}

function onSelectionAction(payload: {
  action: SelectionAction
  text: string
  timeStart: number
  timeEnd: number
}): void {
  emit("selectionAction", payload)
  lastTextSelectedEvent.value = undefined
}

function onSelectionDismissed(): void {
  lastTextSelectedEvent.value = undefined
  emit("selectionDismissed")
}
</script>

<style scoped>
ion-modal {
  --ion-background-color: var(--shruti-immersive-background);
  --ion-text-color: var(--shruti-immersive-text);
}

ion-modal ion-content {
  --background: var(--shruti-immersive-background);
}

ion-modal ion-toolbar {
  --background: var(--shruti-immersive-background);
}

.transcript-text {
  /* Justified edges + scale(1.01) on the active paragraph push glyphs
     past the screen sides without a horizontal gutter — IonContent has
     no default content padding here. */
  padding-inline: 16px;
  /* Floating player covers 56px */
  padding-bottom: 56px;
}

.transcript-dialog {
  z-index: 9000 !important;
}
</style>

<template>
  <IonModal :is-open="open" class="transcript-dialog" @did-dismiss="open = false">
    <IonContent>
      <div class="card">
        <h1 v-if="title" class="title">
          {{ title }}
        </h1>
        <p v-if="author" class="author">
          {{ author }}
        </p>
      </div>

      <!-- Transcript Language Selector -->
      <LanguageSelector
        v-if="availableLanguages.length > 1"
        v-model:active="activeLanguages"
        :languages="availableLanguages"
        :allow-multiple="allowMultipleLanguages"
      />

      <!-- Loading / error / empty / content -->
      <div v-if="isLoading" class="transcript-status">
        <IonSpinner name="crescent" />
      </div>
      <p v-else-if="errorMessage" class="transcript-status transcript-error">
        {{ errorMessage }}
      </p>
      <p v-else-if="hasNoTranscripts" class="transcript-status transcript-empty">
        {{ $t("transcript.noneAvailable") }}
      </p>
      <TranscriptText
        v-else
        class="transcript-text"
        :block-groups="blockGroups"
        :position="position"
        :duration="duration"
        :show-speaker-icons="allowMultipleLanguages"
        :highlight-current-sentence="highlightCurrentSentence"
        @seek="(pos) => emit('seek', pos)"
        @text-selected="onTextSelected"
        @pick-start="emit('pickStart')"
      />

      <!-- Text Selection Actions Popover -->
      <IonPopover
        :translucent="true"
        :animated="true"
        :arrow="false"
        :is-open="isSelectionActionsOpen"
        :event="lastTextSelectedEvent?.event"
        @did-dismiss="onTextSelectionActionDismissed"
      >
        <SelectionActions @action="onTextSelectionActionClicked" />
      </IonPopover>

      <!-- Speaker Floating Chip -->
      <SpeakerFloatingChip />
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { IonContent, IonModal, IonPopover, IonSpinner } from "@ionic/vue"
import LanguageSelector from "./LanguageSelector.vue"
import SelectionActions from "./SelectionActions.vue"
import SpeakerFloatingChip from "./SpeakerFloatingChip.vue"
import TranscriptText, { type TextSelectedEvent } from "./TranscriptText.vue"
import type { UiTranscriptBlocksGroup, UiTranscriptLanguage } from "./types.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type SelectionActionEvent = Pick<TextSelectedEvent, "timeStart" | "timeEnd" | "text"> & {
  action: "copy" | "bookmark" | "share"
}

defineProps<{
  blockGroups: readonly UiTranscriptBlocksGroup[]
  availableLanguages: readonly UiTranscriptLanguage[]
  title: string
  author: string
  position: number
  duration: number
  allowMultipleLanguages: boolean
  highlightCurrentSentence: boolean
  /** True while the transcript is being fetched. Shows a spinner. */
  isLoading?: boolean
  /** Non-null when the transcript fetch failed. Shows the error text. */
  errorMessage?: string | null
  /** True after hydration when the track has no advertised transcripts. */
  hasNoTranscripts?: boolean
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
const lastTextSelectedEvent = ref<TextSelectedEvent>()
const lastTextSelectionAction = ref<string>("")

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

const isSelectionActionsOpen = ref(false)

async function onTextSelected(event: TextSelectedEvent) {
  lastTextSelectedEvent.value = event
  isSelectionActionsOpen.value = true
  lastTextSelectionAction.value = ""
}

function onTextSelectionActionClicked(action: "copy" | "bookmark" | "share") {
  isSelectionActionsOpen.value = false
  if (!lastTextSelectedEvent.value) return
  lastTextSelectionAction.value = action
  emit("selectionAction", { ...lastTextSelectedEvent.value, action })
}

function onTextSelectionActionDismissed() {
  isSelectionActionsOpen.value = false
  if (lastTextSelectedEvent.value && !lastTextSelectionAction.value) {
    emit("selectionDismissed")
  }
}
</script>

<style scoped>
ion-modal ion-content {
  --background: #1d263b;
}

ion-modal ion-toolbar {
  --background: #1d263b;
}

.transcript-text {
  /* Floating player covers 56px. Horizontal gutter so the active
     paragraph (scaled to 1.01 via transform) and justified-text edges
     don't get clipped against the screen sides — IonContent here has
     no default content padding. */
  padding-inline: 16px;
  padding-bottom: 56px;
}

.transcript-dialog {
  z-index: 9000 !important;
}

.card {
  padding: 2px;
}

.title {
  color: white;
  text-align: center;
  font-size: 1.4rem;
  margin-bottom: 0;
  padding-bottom: 0;
  line-height: 1.1;
}

.author {
  opacity: 0.8;
  color: white;
  text-align: center;
  font-size: 14px;
  margin: 12px 0px;
}

.transcript-status {
  display: flex;
  justify-content: center;
  align-items: center;
  color: white;
  opacity: 0.8;
  text-align: center;
  padding: 32px 16px;
  margin: 0;
}

.transcript-error {
  color: #ff8585;
  opacity: 1;
}
</style>

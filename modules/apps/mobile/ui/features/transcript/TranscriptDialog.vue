<template>
  <IonModal
    :is-open="open"
    class="transcript-dialog"
    @did-dismiss="open = false"
  >
    <IonContent>
      <div class="card">
        <h1
          v-if="title"
          class="title"
        >
          {{ title }}
        </h1>
        <p
          v-if="author"
          class="author"
        >
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

      <!-- Transcript Text -->
      <TranscriptText
        class="transcript-text"
        :block-groups="blockGroups"
        :position="position"
        :duration="duration"
        :show-speaker-icons="allowMultipleLanguages"
        :highlight-current-sentence="highlightCurrentSentence"
        @seek="(pos) => emit('seek', pos)"
        @text-selected="onTextSelected"
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
import { ref } from 'vue'
import { IonContent, IonModal, IonPopover } from '@ionic/vue'
import LanguageSelector from './LanguageSelector.vue'
import SelectionActions from './SelectionActions.vue'
import SpeakerFloatingChip from './SpeakerFloatingChip.vue'
import TranscriptText, { type TextSelectedEvent } from './TranscriptText.vue'
import type { UiTranscriptBlocksGroup, UiTranscriptLanguage } from './types.js'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type SelectionActionEvent = Pick<
  TextSelectedEvent,
  'timeStart' | 'timeEnd' | 'text'
> & { action: 'copy' | 'bookmark' | 'share' }


defineProps<{
  blockGroups: readonly UiTranscriptBlocksGroup[]
  availableLanguages: readonly UiTranscriptLanguage[]
  title: string
  author: string
  position: number
  duration: number
  allowMultipleLanguages: boolean
  highlightCurrentSentence: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  selectionAction: [action: SelectionActionEvent]
  selectionDismissed: []
}>()

const open = defineModel<boolean>('open', { default: false, required: true })
const activeLanguages = defineModel<string[]>('activeLanguages', {
  default: [] as string[],
  required: true,
})
const lastTextSelectedEvent = ref<TextSelectedEvent>()
const lastTextSelectionAction = ref<string>('')

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

const isSelectionActionsOpen = ref(false)

async function onTextSelected(event: TextSelectedEvent) {
  lastTextSelectedEvent.value = event
  isSelectionActionsOpen.value = true
  lastTextSelectionAction.value = ''
}

function onTextSelectionActionClicked(action: 'copy' | 'bookmark' | 'share') {
  isSelectionActionsOpen.value = false
  if (!lastTextSelectedEvent.value) return
  lastTextSelectionAction.value = action
  emit('selectionAction', { ...lastTextSelectedEvent.value, action })
}

function onTextSelectionActionDismissed() {
  isSelectionActionsOpen.value = false
  if (
    lastTextSelectedEvent.value &&
    !lastTextSelectionAction.value
  ) {
    emit('selectionDismissed')
  }
}
</script>


<style scoped>
ion-modal ion-content {
  --background: #1D263B;
}

ion-modal ion-toolbar {
  --background: #1D263B;
}

.transcript-text {
  /* Floating player covers 56px */
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

</style>

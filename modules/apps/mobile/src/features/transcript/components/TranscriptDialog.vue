<template>
  <IonModal
    :is-open="open"
    class="transcript-dialog"
    @did-dismiss="open = false"
  >
    <Content>
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
        :paragraphs="paragraphs"
        :position="position"
        :show-speaker-icons="allowMultipleLanguages"
        :highlight-current-sentence="highlightCurrentSentence"
        @seek="position => emit('seek', position)"
        @text-selected="onTextSelected"
      />

      <!-- Text Selection Actions Popover -->
      <IonPopover
        :is-open="isSelectionActionsOpen"
        :translucent="true"
        :animated="true"
        :event="lastTextSelectedEvent?.event"
        :arrow="false"
        @did-dismiss="onTextSelectionActionDismissed"
      >
        <SelectionActions @action="onTextSelectionActionClicked" />
      </IonPopover>
    </Content>
  </IonModal>
</template>


<script setup lang="ts">
import { ref } from 'vue'
import { IonModal, IonPopover } from '@ionic/vue'
import { Content } from '@lectorium/mobile/features/app.core'
import { TranscriptLanguage, TranscriptParagraph } from '../models'
import { TextSelectedEvent, default as TranscriptText } from './TranscriptText.vue'
import { default as LanguageSelector } from './LanguageSelector.vue'
import { default as SelectionActions } from './SelectionActions.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  allowMultipleLanguages: boolean
  availableLanguages: TranscriptLanguage[]
  paragraphs: TranscriptParagraph[]
  position: number
  highlightCurrentSentence: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  selectionAction: [{ text: string, blocks: string[], action: string }]
  selectionDismissed: [{ blocks: string[] }]
}>()

const open = defineModel<boolean>('open', { default: false, required: true })
const activeLanguages = defineModel<string[]>('activeLanguages', { default: [], required: true })
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

function onTextSelectionActionClicked(action: 'copy' | 'bookmark') {
  isSelectionActionsOpen.value = false 
  if (!lastTextSelectedEvent.value) { return }
  lastTextSelectionAction.value = action
  emit('selectionAction', { 
    text: lastTextSelectedEvent.value.text,
    blocks: lastTextSelectedEvent.value.blocks,
    action
  })
}

function onTextSelectionActionDismissed() {
  isSelectionActionsOpen.value = false
  if (
    lastTextSelectedEvent.value && 
    !lastTextSelectionAction.value
  ) {
    emit('selectionDismissed', { 
      blocks: lastTextSelectedEvent.value.blocks 
    })
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
</style>
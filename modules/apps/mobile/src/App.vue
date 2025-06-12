<template>
  <IonApp>
    <IonRouterOutlet />

    <!-- Floating Player -->
    <FloatingPlayer 
      v-model:sticked="transcriptStore.open"
      :playing="player.isPlaying.value"
      :title="player.title.value"
      :author="player.author.value"
      :duration="player.duration.value"
      :position="player.position.value"
      :hidden="!player.trackId.value || keyboardVisible.isKeyboardVisible.value"
    />

    <!-- Transcript Dialog -->
    <TranscriptDialog 
      v-model:open="transcriptStore.open"
      v-model:active-languages="transcriptStore.activeLanguages"
      :allow-multiple-languages="transcriptStore.allowMultipleLanguages"
      :available-languages="transcriptStore.availableLanguages"
      :paragraphs="transcriptStore.localizedTranscript"
      :position="player.position.value"
      @seek="position => p.seek({ position: position })"
      @selection-action="onTextSelectionAction"
      @selection-dismissed="onTextSelectionDismissed"
    />
    
    <!-- Navigation Bar Footer -->
    <NavigationBarHolder v-if="!keyboardVisible.isKeyboardVisible.value" />
  </IonApp>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { IonApp, IonRouterOutlet } from '@ionic/vue'
import { NavigationBarHolder } from '@lectorium/mobile/features/app.appearance'
import { FloatingPlayer, usePlayer, usePlayerControls } from '@lectorium/mobile/features/player'
import { TranscriptDialog, useTranscriptStore } from '@lectorium/mobile/features/transcript'
import { useSyncService } from './features/app.services.sync'
import { useKeyboardVisible, useSafeOperation } from './features/app.core'
import { useNotesFeature } from './features/notes'
import { Clipboard } from '@capacitor/clipboard'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const syncService = useSyncService()
const safeOperation = useSafeOperation()
const player = usePlayerControls()
const p = usePlayer()
const notesFeature = useNotesFeature()
const transcriptStore = useTranscriptStore()
const keyboardVisible = useKeyboardVisible()

async function onTextSelectionAction(
  opts: { text: string, blocks: string[], action: string }
) {
  if (opts.action === 'copy') {
     await Clipboard.write({ string: opts.text })
  } else if (opts.action === 'bookmark') {
    notesFeature.addNote({
      trackId: player.trackId.value,
      text: opts.text,
      blocks: opts.blocks
    })
    transcriptStore.highlight(opts.blocks)
  }
  transcriptStore.removeSelection()
}

function onTextSelectionDismissed() {
  transcriptStore.removeSelection()
}

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

onMounted(async () => {
  safeOperation.execute({
    operation: async () => { await syncService.sync() }
  })
})
</script>

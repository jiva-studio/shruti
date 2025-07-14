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
      :show-progress="config.showPlayerProgress.value"
      :pulsing="!config.tutorialStepsCompleted.value.includes('transcript:open')"
      @click="onFloatingPlayerClicked"
      @play-clicked="onPlayButtonClicked"
    />

    <!-- Transcript Dialog -->
    <TranscriptDialog 
      v-model:open="transcriptStore.open"
      v-model:active-languages="transcriptStore.activeLanguages"
      :allow-multiple-languages="transcriptStore.allowMultipleLanguages"
      :available-languages="transcriptStore.availableLanguages"
      :paragraphs="transcriptStore.localizedTranscript"
      :position="player.position.value"
      :highlight-current-sentence="config.highlightCurrentSentence.value"
      :title="transcriptStore.localizedTitle"
      :author="transcriptStore.localizedAuthorName"
      @seek="position => eventBus.playerSeek.notify(position)"
      @selection-action="onTextSelectionAction"
      @selection-dismissed="onTextSelectionDismissed"
    />
    
    <!-- Navigation Bar Footer -->
    <NavigationHeader :visible="transcriptStore.open" />
    <NavigationFooter v-if="!keyboardVisible.isKeyboardVisible.value" />
  </IonApp>
</template>

<script setup lang="ts">
import { IonApp, IonRouterOutlet } from '@ionic/vue'
import { NavigationFooter, NavigationHeader } from '@blocks/app.appearance'
import { FloatingPlayer, usePlayer } from '@blocks/app.player'
import { TranscriptDialog, useTranscriptStore } from '@blocks/app.transcript'
import { useKeyboardVisible } from '@blocks/app.core'
import { Clipboard } from '@capacitor/clipboard'
import { useConfig } from '@blocks/app.config'
import { useEventBus } from '@shruti/mobile/core'
import { watch } from 'vue'
import { StatusBar, Style } from '@capacitor/status-bar'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const player = usePlayer()
const config = useConfig()
const eventBus = useEventBus()
const transcriptStore = useTranscriptStore()
const keyboardVisible = useKeyboardVisible()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onTextSelectionAction(
  opts: { text: string, blocks: string[], action: string }
) {
  if (opts.action === 'copy') {
     await Clipboard.write({ string: opts.text })
  } else if (opts.action === 'bookmark') {
    eventBus.notesAdd.notify({
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

async function onPlayButtonClicked() {
  await eventBus.playerTogglePause.notify()
}

function onFloatingPlayerClicked() {
  transcriptStore.toggleTranscriptOpen()
  if (!config.tutorialStepsCompleted.value.includes('transcript:open')) {
    config.tutorialStepsCompleted.value.push('transcript:open')
  }
}

watch(
  () => transcriptStore.open,
  (open) => {
    StatusBar.setStyle({ style: open ? Style.Dark : Style.Light })
    StatusBar.setBackgroundColor({ color: open ? '#1D263B' : '#FFFFFF' })
  }
)
</script>

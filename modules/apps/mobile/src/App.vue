<template>
  <IonApp>
    <IonRouterOutlet />

    <!-- Floating Player -->
    <FloatingPlayer
      v-model:sticked="transcriptStore.open"
      :playing="playerStore.isPlaying"
      :title="playerStore.title"
      :author="playerStore.author"
      :duration="playerStore.duration"
      :position="playerStore.position"
      :hidden="!playerStore.playlistItemId || keyboardVisible.isKeyboardVisible.value"
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
      :block-groups="transcriptStore.localizedTranscript"
      :position="playerStore.position"
      :duration="playerStore.duration"
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
    <IonToast
      :is-open="trackAudioExcerptStore.busy"
      :duration="3500"
      :translucent="true"
      :message="$t('share.loadingAudioExcerpt')"
      color="warning"
      position="top"
    />
  </IonApp>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { IonApp, IonRouterOutlet, IonToast } from '@ionic/vue'
import { Clipboard } from '@capacitor/clipboard'
import { StatusBar, Style } from '@capacitor/status-bar'
import { useEventBus } from '@lectorium/mobile/core'
import { NavigationFooter, NavigationHeader } from '@blocks/app.appearance'
import { FloatingPlayer } from '@blocks/app.player'
import { SelectionActionEvent, TranscriptDialog, useTranscriptStore } from '@blocks/app.transcript'
import { useKeyboardVisible } from '@blocks/app.core'
import { useConfig } from '@blocks/app.config'
import { usePlayerStore } from '@blocks/app.player.state'
import { useTrackAudioExcerptStore } from '@blocks/app.share.track.audio.excerpt'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const eventBus = useEventBus()
const playerStore = usePlayerStore()
const transcriptStore = useTranscriptStore()
const keyboardVisible = useKeyboardVisible()
const trackAudioExcerptStore = useTrackAudioExcerptStore()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onTextSelectionAction(event: SelectionActionEvent) {
  if (event.action === 'copy') {
    const textWithoutTags = event.text.replace(/<[^>]*>/g, '')
    await Clipboard.write({ string: textWithoutTags })
  } else if (event.action === 'bookmark') {
    eventBus.notesAdd.notify({
      trackId: playerStore.trackId,
      text: event.text,
      timeStart: event.timeStart,
      timeEnd: event.timeEnd,
    })
    transcriptStore.bookmark(event.timeStart, event.timeEnd)
  } else if (event.action === 'share') {
    eventBus.shareSendTrackExcerpt.notify({
      trackId: playerStore.trackId,
      text: event.text,
      timeStart: event.timeStart,
      timeEnd: event.timeEnd,
      shareAudio: true,
    })
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

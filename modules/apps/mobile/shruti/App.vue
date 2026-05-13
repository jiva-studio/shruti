<template>
  <IonApp>
    <IonRouterOutlet />
    <FloatingPlayer
      v-model:mix-position="player.mixPosition"
      v-model:playback-speed="player.playbackSpeed"
      :playing="player.playing"
      :title="player.title"
      :author="player.authorName"
      :duration="player.durationMs"
      :position="player.positionMs"
      :show-progress="showPlayerProgress"
      :sticked="transcriptStore.open && dialog.mirrorsActivePlayer.value"
      :hidden="floatingPlayerHidden"
      :pulsing="pulsing"
      :play-button-size="playButtonSize"
      @play-clicked="onTogglePause"
      @click="onOpenTranscript"
      @mix-tick="onSliderTick"
      @speed-tick="onSliderTick"
      @skip-back="onSkipBack"
      @skip-forward="onSkipForward"
    />
    <TranscriptDialog
      v-model:open="dialog.isOpen.value"
      v-model:active-languages="activeLanguagesModel"
      :block-groups="dialog.blockGroups.value"
      :available-languages="dialog.availableLanguages.value"
      :title="dialog.title.value"
      :author="dialog.author.value"
      :position="dialog.position.value"
      :duration="dialog.duration.value"
      :allow-multiple-languages="dialog.allowMultipleLanguages.value"
      :should-highlight-current-sentence="dialog.highlightCurrentSentence.value"
      :enable-active-prominence="dialog.mirrorsActivePlayer.value"
      :is-loading="dialog.isLoading.value"
      :error-message="dialog.error.value"
      :has-no-transcripts="dialog.hasNoTranscripts.value"
      @seek="dialog.onSeek"
      @selection-action="dialog.onSelectionAction"
      @pick-start="dialog.onPickStart"
      @close="dialog.onClose"
    />
  </IonApp>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IonApp, IonRouterOutlet } from "@ionic/vue"
import { FloatingPlayer } from "@ui/features/player/index.js"
import { TranscriptDialog } from "@ui/features/transcript/index.js"
import { useOverlaysStore } from "@shruti/stores/useOverlaysStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { useTranscriptDialogController } from "@shruti/composables/useTranscriptDialogController.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useLocaleSync } from "@shruti/composables/useLocaleSync.js"
import { usePlayerProgressFlush } from "@shruti/composables/usePlayerProgressFlush.js"
import { usePlayerTutorialPulse } from "@shruti/composables/usePlayerTutorialPulse.js"
import { useShruti } from "@shruti/shruti.js"

const app = useShruti()
const player = usePlayerStore()
const transcriptStore = useTranscriptStore()
const overlays = useOverlaysStore()
// Resolve the UI language ref first so the transcript dialog controller
// can localize the track title + author name reactively (issue #367).
// Switching language while the dialog is open re-derives the header from
// the cached entities — no extra repo calls.
const appLanguage = useAppLanguage()
const dialog = useTranscriptDialogController(appLanguage)
// Hide the FloatingPlayer when:
//  - the player has nothing to show (default),
//  - an ActionSheet is up — keeps the bottom buttons reachable,
//  - the transcript dialog is open in preview mode (Search → Open
//    transcript) — the player belongs to a different track and
//    shouldn't react to taps on the preview surface.
const floatingPlayerHidden = computed<boolean>(() => {
  if (!player.open) return true
  if (overlays.actionSheetOpen) return true
  if (transcriptStore.open && !dialog.mirrorsActivePlayer.value) return true
  return false
})
const showPlayerProgressConfig = useConfig<boolean>("settings.showPlayerProgress", true)
const showPlayerProgress = computed(() => showPlayerProgressConfig.value)

const playButtonSize = app.platform === "android" ? 48 : 44

useLocaleSync(appLanguage)
usePlayerProgressFlush()
const pulsing = usePlayerTutorialPulse()

// LanguageSelector wants a mutable string[] v-model. Wrap the readonly
// controller ref so two-way binding still compiles.
const activeLanguagesModel = computed<string[]>({
  get: () => [...dialog.activeLanguages.value],
  set: (next) => {
    dialog.activeLanguages.value = next
  },
})

async function onTogglePause(): Promise<void> {
  await player.togglePause()
}

// Legacy UX: tapping the floating player opens the transcript; tapping
// it again closes the transcript without stopping playback. The dialog
// also exposes its own close button (top-right) so iOS users (no
// hardware Back) and preview-mode users (player hidden) always have a
// visible exit.
function onOpenTranscript(): void {
  if (transcriptStore.open) transcriptStore.close()
  else if (player.trackId) transcriptStore.show(player.trackId)
}

function onSliderTick(): void {
  // Single haptic channel for both sliders — fires whenever the puck
  // does something a finger should feel (detent crossings, preset
  // boundaries, snap-back to centre).
  void app.haptics.impact("light")
}

async function onSkipBack(): Promise<void> {
  await player.skipBack()
}

async function onSkipForward(): Promise<void> {
  await player.skipForward()
}
</script>

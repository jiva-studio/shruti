<template>
  <IonApp>
    <IonRouterOutlet />
    <FloatingPlayer
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { IonApp, IonRouterOutlet } from "@ionic/vue"
import { FloatingPlayer } from "@ui/features/player/index.js"
import { TranscriptDialog } from "@ui/features/transcript/index.js"
import { useOverlaysStore } from "@lectorium/stores/useOverlaysStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { useTutorialStore } from "@lectorium/stores/useTutorialStore.js"
import { useTranscriptDialogController } from "@lectorium/composables/useTranscriptDialogController.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { setLocale, SUPPORTED_LOCALES, type SupportedLocale } from "@lectorium/i18n/index.js"
import { useLectorium } from "@lectorium/lectorium.js"

const app = useLectorium()
const player = usePlayerStore()
const transcriptStore = useTranscriptStore()
const overlays = useOverlaysStore()
const tutorial = useTutorialStore()
const dialog = useTranscriptDialogController()
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

// App-wide UI locale sync. Mounted at the root so the whole tree
// (tabs, views, modals) sees the persisted language the moment the
// preferences adapter resolves it — not only after the user visits
// the Settings screen.
const appLanguage = useAppLanguage()
watch(
  appLanguage,
  (next) => {
    if ((SUPPORTED_LOCALES as readonly string[]).includes(next)) {
      setLocale(next as SupportedLocale)
    }
  },
  { immediate: true }
)

// LanguageSelector wants a mutable string[] v-model. Wrap the readonly
// controller ref so two-way binding still compiles.
const activeLanguagesModel = computed<string[]>({
  get: () => [...dialog.activeLanguages.value],
  set: (next) => {
    dialog.activeLanguages.value = next
  },
})

// Persist whatever position the audio engine has when the user
// backgrounds, refreshes, or closes the tab. The throttled tick can be
// up to 5 s stale; this best-effort flush narrows the window.
function flushPlayerProgress(): void {
  player.flushProgressNow()
}
function onVisibilityChange(): void {
  if (document.hidden) flushPlayerProgress()
}

onMounted(() => {
  void tutorial.load()
  document.addEventListener("visibilitychange", onVisibilityChange)
  window.addEventListener("pagehide", flushPlayerProgress)
})

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange)
  window.removeEventListener("pagehide", flushPlayerProgress)
})

const pulsing = ref<boolean>(false)
watch(
  () => player.open,
  (open, prev) => {
    if (!prev && open && tutorial.loaded && !tutorial.flags.player) {
      pulsing.value = true
      setTimeout(() => {
        pulsing.value = false
      }, 3000)
      void tutorial.dismiss("player")
    }
  }
)

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
</script>

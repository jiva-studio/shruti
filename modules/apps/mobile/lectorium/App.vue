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
    <!--
      App-level paywall: a single SubscriptionDialog instance shared by
      every "this is Pro" gate (Settings, Smart Library, Notes Studio…).
      Trigger is `usePaywallStore().requestOpen()` from anywhere; close
      flips the same store flag. Mounted here so it survives route
      changes — a non-Pro user can tap "Open in Studio" on the Notes
      tab and see the paywall even though SettingsView isn't mounted.
    -->
    <SubscriptionDialog
      v-model:open="paywall.open"
      :packages="paywallSubscription.packages"
      :is-subscribed="paywallSubscription.isSubscribed"
      :purchasing="paywallSubscription.purchasing"
      :restoring="paywallSubscription.restoring"
      :legal-documents="paywallSubscription.legalDocuments"
      @subscribe="paywallSubscription.onSubscribe"
      @restore="paywallSubscription.onRestore"
    />
  </IonApp>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from "vue"
import { useRoute } from "vue-router"
import { IonApp, IonRouterOutlet } from "@ionic/vue"
import { FloatingPlayer } from "@ui/features/player/index.js"
import { SubscriptionDialog } from "@ui/features/settings/index.js"
import { TranscriptDialog } from "@ui/features/transcript/index.js"
import { useOverlaysStore } from "@lectorium/stores/useOverlaysStore.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { useTutorialStore } from "@lectorium/stores/useTutorialStore.js"
import { useSubscriptionBinding } from "@lectorium/views/Settings/composables/useSubscriptionBinding.js"
import { useTranscriptDialogController } from "@lectorium/composables/useTranscriptDialogController.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useAutoArchiveSweep } from "@lectorium/composables/useAutoArchiveSweep.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useKeyboardVisibility } from "@lectorium/composables/useKeyboardVisibility.js"
import { useLocaleSync } from "@lectorium/composables/useLocaleSync.js"
import { usePlayerProgressFlush } from "@lectorium/composables/usePlayerProgressFlush.js"
import { usePlayerTutorialPulse } from "@lectorium/composables/usePlayerTutorialPulse.js"
import { useAutoDownloadLoop } from "@lectorium/composables/useAutoDownloadLoop.js"
import { registerMainPlayerPauser } from "@lectorium/composables/useNotesInlineAudio.js"
import { useLectorium } from "@lectorium/lectorium.js"

const app = useLectorium()
const route = useRoute()
const player = usePlayerStore()
const transcriptStore = useTranscriptStore()
const tutorial = useTutorialStore()
const overlays = useOverlaysStore()
const paywall = usePaywallStore()
// Subscription binding wires RevenueCat actions + i18n into the dialog.
// Initialised once here so the dialog is fully wired no matter which
// view triggers `paywall.requestOpen()`.
const paywallSubscription = useSubscriptionBinding()
// Resolve the UI language ref first so the transcript dialog controller
// can localize the track title + author name reactively (issue #367).
// Switching language while the dialog is open re-derives the header from
// the cached entities — no extra repo calls.
const appLanguage = useAppLanguage()
const dialog = useTranscriptDialogController(appLanguage)
const { isKeyboardOpen } = useKeyboardVisibility()
// Hide the FloatingPlayer when:
//  - the player has nothing to show (default),
//  - the on-screen keyboard is visible — the floating chrome would
//    overlap the input or accessory area while typing,
//  - an ActionSheet is up — keeps the bottom buttons reachable,
//  - the transcript dialog is open in preview mode (Search → Open
//    transcript) — the player belongs to a different track and
//    shouldn't react to taps on the preview surface,
//  - on the chat tab the floating chrome would cover the sliding
//    input bar; hide it for the duration of the chat view.
const floatingPlayerHidden = computed<boolean>(() => {
  if (!player.open) return true
  if (isKeyboardOpen.value) return true
  if (overlays.actionSheetOpen) return true
  if (transcriptStore.open && !dialog.mirrorsActivePlayer.value) return true
  const routeName = route.name
  if (routeName === "chat" || routeName === "chat-session") return true
  return false
})
const showPlayerProgressConfig = useConfig<boolean>("settings.showPlayerProgress", true)
const showPlayerProgress = computed(() => showPlayerProgressConfig.value)

const playButtonSize = app.platform === "android" ? 48 : 44

useLocaleSync(appLanguage)
usePlayerProgressFlush()
useAutoArchiveSweep()
const pulsing = usePlayerTutorialPulse()
useAutoDownloadLoop()

// When a Notes inline excerpt starts playing, pause the main lecture so
// the user never hears two streams at once. The notes coordinator owns
// the pauser set; we register a callback that asks the player store to
// pause if it's currently playing.
let disposeMainPauser: (() => void) | null = null
onMounted(() => {
  disposeMainPauser = registerMainPlayerPauser(() => {
    if (player.playing) void player.togglePause()
  })
})
onBeforeUnmount(() => {
  disposeMainPauser?.()
  disposeMainPauser = null
})

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
  else if (player.trackId) {
    // Explicit user tap — mark the transcript as discovered so the
    // FloatingPlayer pulse cue stops inviting on subsequent opens.
    void tutorial.dismiss("transcriptOpened")
    transcriptStore.show(player.trackId)
  }
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

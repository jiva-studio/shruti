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
      ref="transcriptDialogRef"
      v-model:open="dialog.isOpen.value"
      v-model:active-languages="activeLanguagesModel"
      :block-groups="dialog.blockGroups.value"
      :available-languages="dialog.availableLanguages.value"
      :title="dialog.title.value"
      :author="dialog.author.value"
      :description="dialog.description.value"
      :chapters="dialog.chapters.value"
      :position="dialog.position.value"
      :duration="dialog.duration.value"
      :allow-multiple-languages="dialog.allowMultipleLanguages.value"
      :should-highlight-current-sentence="dialog.highlightCurrentSentence.value"
      :auto-scroll="
        dialog.autoScrollCfg.value && dialog.mirrorsActivePlayer.value && purchases.isSubscribed
      "
      :enable-active-prominence="dialog.mirrorsActivePlayer.value"
      :is-loading="dialog.isLoading.value"
      :error-message="dialog.error.value"
      :has-no-transcripts="dialog.hasNoTranscripts.value"
      @seek="dialog.onSeek"
      @chapter-seek="dialog.onChapterSeek"
      @text-selected="dialog.onTextSelected"
      @note-tapped="dialog.onNoteTapped"
      @pick-start="dialog.onPickStart"
      @close="dialog.onClose"
    />
    <!--
      Selection popover is mounted as a SIBLING of TranscriptDialog (not
      inside it). When the dialog dismisses, its child tree is torn down
      synchronously — if the popover lived in there mid-animation, Vue
      tried to insertBefore into an already-gone parent and threw,
      leaving the modal half-open on "no transcripts" state. Sibling
      mount lets each overlay manage its own lifecycle.
    -->
    <TranscriptSelectionPopover
      :selection="dialog.lastTextSelectedEvent.value"
      :existing="dialog.lastNoteTappedEvent.value"
      @action="onSelectionPopoverAction"
      @dismissed="onSelectionPopoverDismissed"
    />
    <TrackSheet />
    <EmailSignInModal v-model:open="overlays.emailSignInOpen" />
  </IonApp>
</template>

<script setup lang="ts">
import { computed, provide, useTemplateRef } from "vue"
import { IonApp, IonRouterOutlet } from "@ionic/vue"
import router from "@lectorium/router/index.js"
import { TRACK_META_CONFIG_KEY } from "@ui/components/tracks/list/index.js"
import { ASSET_FAILOVER_KEY, FILES_STORAGE_KEY } from "@ui/primitives/index.js"
import { getRegions } from "@lectorium/services/regionsRegistry.js"
import { createAssetFailover } from "@lectorium/services/withAssetRegionFailover.js"
import { useTrackMetadataFields } from "@lectorium/composables/useTrackMetadataFields.js"
import { FloatingPlayer } from "@ui/features/player/index.js"
import { TranscriptDialog, TranscriptSelectionPopover } from "@ui/features/transcript/index.js"
import TrackSheet from "@lectorium/components/TrackSheet.vue"
import EmailSignInModal from "@lectorium/components/EmailSignInModal.vue"
import type { SelectionActionEvent } from "@lectorium/composables/transcript/useTranscriptSelectionActions.js"
import { useOverlaysStore } from "@lectorium/stores/useOverlaysStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { useTutorialStore } from "@lectorium/stores/useTutorialStore.js"
import { useTranscriptDialogController } from "@lectorium/composables/useTranscriptDialogController.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useAutoArchiveSweep } from "@lectorium/composables/useAutoArchiveSweep.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useKeyboardVisibility } from "@lectorium/composables/useKeyboardVisibility.js"
import { useLocaleSync } from "@lectorium/composables/useLocaleSync.js"
import { useAppLanguageSeed } from "@lectorium/composables/useAppLanguageSeed.js"
import { usePlayerProgressFlush } from "@lectorium/composables/usePlayerProgressFlush.js"
import { usePlayerProgressCadence } from "@lectorium/composables/usePlayerProgressCadence.js"
import { usePlayerTutorialPulse } from "@lectorium/composables/usePlayerTutorialPulse.js"
import { useAutoDownloadLoop } from "@lectorium/composables/useAutoDownloadLoop.js"
import { useChatStoreProactiveSync } from "@lectorium/composables/useChatStoreProactiveSync.js"
import { useProactiveDeepLink } from "@lectorium/composables/useProactiveDeepLink.js"
import { useProactiveScheduler } from "@lectorium/composables/useProactiveScheduler.js"
import { useChatResume } from "@lectorium/composables/useChatResume.js"
import { useUserNotifier } from "@lectorium/composables/useUserNotifier.js"
import { useChatTurnNotifications } from "@lectorium/composables/useChatTurnNotifications.js"
import { useLectorium } from "@lectorium/lectorium.js"

const app = useLectorium()
// Use the imported router singleton's reactive `currentRoute`, not
// `useRoute()`. In Vite dev the inject('route location') symbol can be
// unresolved at App's setup (router.isReady() fires before the provide
// chain is fully wired in the browser build) — useRoute() then returns
// a plain `undefined` (not a ref), so the `floatingPlayerHidden`
// computed never reactively picks up later route changes. The
// module-singleton router always exposes the same `currentRoute` ref.
const currentRoute = router.currentRoute
const player = usePlayerStore()
const transcriptStore = useTranscriptStore()
const tutorial = useTutorialStore()
const overlays = useOverlaysStore()
const purchases = usePurchasesStore()
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
  const routeName = currentRoute.value.name
  if (routeName === "chat") return true
  return false
})
const showPlayerProgressConfig = useConfig<boolean>("settings.showPlayerProgress", true)
const showPlayerProgress = computed(() => showPlayerProgressConfig.value)

// Provide the user's track-row metadata layout to every TrackMetaLine in
// the app (Home / Search / Library / playlist). Settings edits this same
// preference live; non-subscribers always get the default layout.
provide(TRACK_META_CONFIG_KEY, useTrackMetadataFields().config)
provide(FILES_STORAGE_KEY, app.filesStorage)
// Last-resort CDN region failover for covers/avatars: when the active region
// can't serve an asset (and same-region retries are spent), try the others and
// promote the one that works so streaming / transcripts follow it too.
provide(
  ASSET_FAILOVER_KEY,
  createAssetFailover({
    getRegions,
    getActiveServer: () => app.activeServer.value,
    promote: (id) => app.setActiveServerById(id),
    fetch: (url) => app.filesStorage.get(url),
  })
)

const playButtonSize = app.platform === "android" ? 48 : 44

useLocaleSync(appLanguage)
useAppLanguageSeed(appLanguage)
usePlayerProgressFlush()
usePlayerProgressCadence()
useAutoArchiveSweep()
const pulsing = usePlayerTutorialPulse()
useAutoDownloadLoop()
useProactiveScheduler()
useChatResume()
useUserNotifier()
useChatTurnNotifications()
useProactiveDeepLink()
useChatStoreProactiveSync()

// Cross-source audio coordination (lecture ↔ chat/notes snippets) lives
// in the player store, which registers itself with useAudioOrchestrator.
// App.vue no longer needs to wire it.

// LanguageSelector wants a mutable string[] v-model. Wrap the readonly
// controller ref so two-way binding still compiles.
const activeLanguagesModel = computed<string[]>({
  get: () => [...dialog.activeLanguages.value],
  set: (next) => {
    dialog.activeLanguages.value = next
  },
})

// Template ref to the dialog so we can drop the browser's native
// selection range after the sibling popover finishes — the drag-select
// highlight otherwise lingers on the transcript text. The controller
// handles state cleanup (selection refs), the dialog handles DOM.
const transcriptDialogRef = useTemplateRef<{ clearSelection: () => void }>("transcriptDialogRef")

function onSelectionPopoverAction(payload: SelectionActionEvent): void {
  void dialog.onSelectionAction(payload)
  transcriptDialogRef.value?.clearSelection()
}

function onSelectionPopoverDismissed(): void {
  dialog.onSelectionDismissed()
  transcriptDialogRef.value?.clearSelection()
}

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

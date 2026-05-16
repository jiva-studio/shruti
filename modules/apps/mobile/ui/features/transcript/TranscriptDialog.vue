<template>
  <IonModal
    :is-open="open"
    class="transcript-dialog"
    @did-present="onModalPresented"
    @did-dismiss="open = false"
  >
    <IonContent ref="contentRef">
      <IonButton
        class="close-button"
        fill="clear"
        size="small"
        :aria-label="$t('app.close')"
        @click="emit('close')"
      >
        <IconXFilled slot="icon-only" :size="20" />
      </IonButton>

      <TranscriptDialogHeader :title="title" :author="author" />

      <LanguageSelector
        v-if="availableLanguages.length > 1"
        v-model:active="activeLanguages"
        :languages="availableLanguages"
        :allow-multiple="allowMultipleLanguages"
      />

      <TranscriptStatus
        :state="statusState"
        :error-message="errorMessage"
        :empty-message="$t('transcript.noneAvailable')"
        :loading-message="$t('transcript.loading')"
      />
      <TranscriptText
        v-if="statusState === null"
        ref="transcriptText"
        class="transcript-text"
        :groups="blockGroups"
        :position="position"
        :duration="duration"
        :display-speaker-icons="allowMultipleLanguages"
        :should-highlight-current-sentence="
          enableActiveProminence !== false && shouldHighlightCurrentSentence
        "
        :enable-active-prominence="enableActiveProminence !== false"
        @seek="(pos) => emit('seek', pos)"
        @text-selected="onTextSelected"
        @note-tapped="onNoteTapped"
        @pick-start="emit('pickStart')"
      />

      <TranscriptSelectionPopover
        :selection="lastTextSelectedEvent"
        :existing="lastNoteTappedEvent"
        @action="onSelectionAction"
        @dismissed="onSelectionDismissed"
      />

      <SpeakerFloatingChip />
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue"
import { IonButton, IonContent, IonModal } from "@ionic/vue"
import { IconXFilled } from "@tabler/icons-vue"
import LanguageSelector from "./LanguageSelector.vue"
import SpeakerFloatingChip from "./SpeakerFloatingChip.vue"
import TranscriptDialogHeader from "./TranscriptDialogHeader.vue"
import TranscriptStatus from "./TranscriptStatus.vue"
import TranscriptSelectionPopover, {
  type SelectionAction,
  type ExistingNoteSelection,
} from "./TranscriptSelectionPopover.vue"
import TranscriptText, { type TextSelectedEvent, type NoteTappedEvent } from "./TranscriptText.vue"
import type { UiTranscriptBlocksGroup, UiTranscriptLanguage } from "./types.js"

export type SelectionActionEvent = Pick<TextSelectedEvent, "timeStart" | "timeEnd" | "text"> & {
  action: SelectionAction
  /** Set when the action is `"delete"` (tap-on-highlight path); empty
   *  array otherwise. The controller uses this to drive the notes-store
   *  remove call. */
  noteIds: readonly string[]
}

const props = defineProps<{
  blockGroups: readonly UiTranscriptBlocksGroup[]
  availableLanguages: readonly UiTranscriptLanguage[]
  title: string
  author: string
  position: number
  duration: number
  allowMultipleLanguages: boolean
  shouldHighlightCurrentSentence: boolean
  /** True while the transcript is being fetched. Shows a spinner. */
  isLoading?: boolean
  /** Non-null when the transcript fetch failed. Shows the error text. */
  errorMessage?: string | null
  /** True after hydration when the track has no advertised transcripts. */
  hasNoTranscripts?: boolean
  /**
   * When false, the active-paragraph prompter effect (scale-up of the
   * current group, scale-down + fade of the rest) is suppressed. Use
   * for preview-style opens where the dialog isn't tied to live
   * playback and `position` stays at 0.
   */
  enableActiveProminence?: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  selectionAction: [action: SelectionActionEvent]
  selectionDismissed: []
  /** Long-press on a selectable block — controller fires platform haptics. */
  pickStart: []
  /** User tapped the explicit close button (top-right corner). */
  close: []
}>()

const open = defineModel<boolean>("open", { default: false, required: true })
const activeLanguages = defineModel<string[]>("activeLanguages", {
  default: [] as string[],
  required: true,
})

const statusState = computed<"loading" | "error" | "empty" | null>(() => {
  if (props.isLoading) return "loading"
  if (props.errorMessage) return "error"
  if (props.hasNoTranscripts) return "empty"
  return null
})

const lastTextSelectedEvent = ref<TextSelectedEvent>()
/**
 * Mirrors `lastTextSelectedEvent` for the tap-on-highlight path. Setting
 * this drives the popover into `mode="existing"` (Copy/Share/Delete);
 * clearing it closes the popover, same lifecycle as a drag-select event.
 * Kept separate from `lastTextSelectedEvent` so the two flows stay
 * orthogonal — opening one always clears the other.
 */
const lastNoteTappedEvent = ref<ExistingNoteSelection>()
const transcriptText = useTemplateRef<{ clearSelection: () => void }>("transcriptText")
const contentRef = useTemplateRef<{ $el: HTMLElement }>("contentRef")

/**
 * Has the user manually scrolled since the auto-scroll attempted to
 * land on the active paragraph? Set on the first touchstart/wheel after
 * `onModalPresented` so a smooth animation in-flight stops fighting the
 * user, and the retry watcher below stays out of the way.
 *
 * Reset when the modal closes so the next open is a fresh attempt.
 */
const userScrolled = ref<boolean>(false)
const autoScrollSettled = ref<boolean>(false)

function attachUserScrollListeners(host: HTMLElement): () => void {
  const onUserScroll = (): void => {
    userScrolled.value = true
  }
  host.addEventListener("touchstart", onUserScroll, { passive: true, once: true })
  host.addEventListener("wheel", onUserScroll, { passive: true, once: true })
  return () => {
    host.removeEventListener("touchstart", onUserScroll)
    host.removeEventListener("wheel", onUserScroll)
  }
}

let detachUserScroll: (() => void) | null = null

function tryScrollToActive(host: HTMLElement): boolean {
  const active = host.querySelector(".transcript-text .paragraph") as HTMLElement | null
  if (!active) return false
  // Smooth scroll so the jump from "top of doc" to the current paragraph
  // reads as a deliberate animation rather than an instant jolt — matches
  // how the prompter scaling already eases in around the same paragraph.
  active.scrollIntoView({ behavior: "smooth", block: "center" })
  return true
}

/**
 * Snap the scroll position onto the active paragraph as soon as the
 * modal animation finishes. The block layout is identified by the
 * `.paragraph` class set in `TranscriptText.vue` (the prompter scales
 * up the currently-playing group). If there's no active block — e.g.
 * `position` is still 0 or this is a preview-mode open — the watcher
 * below retries once `position` propagates and a `.paragraph` exists.
 */
async function onModalPresented(): Promise<void> {
  await nextTick()
  userScrolled.value = false
  autoScrollSettled.value = false
  const host = contentRef.value?.$el
  if (!host) return
  detachUserScroll = attachUserScrollListeners(host)
  if (tryScrollToActive(host)) autoScrollSettled.value = true
}

// Cold-open retry: if `position` was 0 (or the active paragraph hadn't
// rendered yet) at modal-present time, retry on the first `position`
// update. The user-scroll guard stops the retry from yanking the
// viewport after a manual pull.
watch(
  () => props.position,
  async () => {
    if (autoScrollSettled.value) return
    if (userScrolled.value) return
    if (!open.value) return
    await nextTick()
    const host = contentRef.value?.$el
    if (!host) return
    if (tryScrollToActive(host)) autoScrollSettled.value = true
  }
)

// Reset on close so the next open starts clean.
watch(open, (next) => {
  if (next) return
  autoScrollSettled.value = false
  userScrolled.value = false
  detachUserScroll?.()
  detachUserScroll = null
})

function onTextSelected(event: TextSelectedEvent): void {
  lastNoteTappedEvent.value = undefined
  lastTextSelectedEvent.value = event
}

function onNoteTapped(event: NoteTappedEvent): void {
  lastTextSelectedEvent.value = undefined
  lastNoteTappedEvent.value = { noteIds: event.noteIds, event: event.event }
}

function onSelectionAction(payload: {
  action: SelectionAction
  text: string
  timeStart: number
  timeEnd: number
  noteIds: readonly string[]
}): void {
  emit("selectionAction", payload)
  lastTextSelectedEvent.value = undefined
  lastNoteTappedEvent.value = undefined
  transcriptText.value?.clearSelection()
}

function onSelectionDismissed(): void {
  lastTextSelectedEvent.value = undefined
  lastNoteTappedEvent.value = undefined
  transcriptText.value?.clearSelection()
  emit("selectionDismissed")
}
</script>

<style scoped>
ion-modal {
  --ion-background-color: var(--lectorium-immersive-background);
  --ion-text-color: var(--lectorium-immersive-text);
}

ion-modal ion-content {
  --background: var(--lectorium-immersive-background);
}

ion-modal ion-toolbar {
  --background: var(--lectorium-immersive-background);
}

.transcript-text {
  /* Justified edges + scale(1.01) on the active paragraph push glyphs
     past the screen sides without a horizontal gutter — IonContent has
     no default content padding here. */
  padding-inline: 16px;
  /* Floating player covers 56px */
  padding-bottom: 56px;
}

.transcript-dialog {
  /* Below FloatingPlayer (z-index: 999) so the legacy "tap player to
     close transcript" UX still works in player-mode. Below Ionic
     action-sheet/alert/loading/toast (~1001) so those still win when
     stacked over the dialog. */
  z-index: 500 !important;
}

.close-button {
  /* Pinned over the immersive content. The tap target sits inside the
     safe-area inset so it stays clear of the notch / status bar on
     both iOS and Android. */
  position: absolute;
  top: calc(env(safe-area-inset-top) + 4px);
  right: 4px;
  z-index: 1;
  --color: var(--lectorium-immersive-text);
  --padding-start: 8px;
  --padding-end: 8px;
  margin: 0;
}
</style>

<script setup lang="ts">
import { computed, nextTick, useTemplateRef } from "vue"
import { IonButton, IonContent, IonModal } from "@ionic/vue"
import { IconXFilled } from "@tabler/icons-vue"
import LanguageSelector from "./LanguageSelector.vue"
import LectureOutline from "@ui/components/LectureOutline.vue"
import TranscriptDialogHeader from "./TranscriptDialogHeader.vue"
import { scrollToChapterHeading, type ScrollableHost } from "./chapterScroll.js"
import { useTranscriptAutoScroll } from "./useTranscriptAutoScroll.js"
import TranscriptStatus from "./TranscriptStatus.vue"
import TranscriptText, { type TextSelectedEvent, type NoteTappedEvent } from "./TranscriptText.vue"
import type { UiTranscriptBlocksGroup, UiTranscriptLanguage } from "./types.js"
import type { UiOutlineChapter } from "@ui/components/types.js"

const props = defineProps<{
  blockGroups: readonly UiTranscriptBlocksGroup[]
  availableLanguages: readonly UiTranscriptLanguage[]
  title: string
  author: string
  /** Lecture description shown above the transcript (null/absent → hidden). */
  description?: string | null
  /** Chapter outline shown above the transcript; a tap emits `seek`. */
  chapters?: readonly UiOutlineChapter[]
  position: number
  duration: number
  allowMultipleLanguages: boolean
  /** Languages whose transcript holds a dialogue. Only those get the per-line
   *  speaker icon and the speaker-change dash. */
  multiSpeakerLanguages: ReadonlySet<string>
  shouldHighlightCurrentSentence: boolean
  /** Pro-gated follow: scroll to the active paragraph on open, then keep it
   *  in view during playback. The parent gates it on the subscription. */
  autoScroll?: boolean
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

const open = defineModel<boolean>("open", { default: false, required: true })

const activeLanguages = defineModel<string[]>("activeLanguages", {
  default: [] as string[],
  required: true,
})

const emit = defineEmits<{
  seek: [position: number]
  /** A chapter (top widget or inline heading) was tapped — the controller
   *  starts playback from `startMs`; the dialog scrolls to the heading. */
  "chapter-seek": [startMs: number]
  /** Drag-select finished — payload describes the selected range. The
   *  app-level `TranscriptSelectionPopover` watches this to open. */
  "text-selected": [event: TextSelectedEvent]
  /** User tapped an already-highlighted span — opens the popover in
   *  Copy/Share/Delete mode against the underlying note id(s). */
  "note-tapped": [event: NoteTappedEvent]
  /** Long-press on a selectable block — controller fires platform haptics. */
  "pick-start": []
  /** User tapped a not-yet-translated (ghost) language chip — the controller
   *  requests an on-demand translation into that language. */
  translate: [code: string]
  /** User tapped the explicit close button (top-right corner). */
  close: []
}>()

const statusState = computed<"loading" | "error" | "empty" | null>(() => {
  if (props.isLoading) return "loading"
  if (props.errorMessage) return "error"
  if (props.hasNoTranscripts) return "empty"
  return null
})

const transcriptText = useTemplateRef<{ clearSelection: () => void }>("transcriptText")
const contentRef = useTemplateRef<{ $el: HTMLElement }>("contentRef")

// Exposed so the app-level orchestrator can drop the browser's native
// selection range after the sibling popover finishes an action — the
// drag-select highlight otherwise lingers visually on the transcript.
defineExpose({
  clearSelection(): void {
    transcriptText.value?.clearSelection()
  },
})

const { onModalPresented } = useTranscriptAutoScroll({
  contentRef,
  open,
  position: () => props.position,
  autoScroll: () => props.autoScroll ?? false,
})

// With Pro auto-scroll on, the follow already force-scrolls the resulting
// seek — let it own the scroll, two smooth-scrolls jank on iOS WebKit.
function onChapterTap(startMs: number): void {
  emit("chapter-seek", startMs)
  if (!props.autoScroll) void scrollToChapter(startMs)
}

async function scrollToChapter(startMs: number): Promise<void> {
  await nextTick()
  await scrollToChapterHeading(contentRef.value?.$el as ScrollableHost | undefined, startMs)
}
</script>

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
        tabindex="-1"
        :aria-label="$t('app.close')"
        @click="emit('close')"
      >
        <IconXFilled slot="icon-only" :size="20" />
      </IonButton>

      <TranscriptDialogHeader :title="title" :author="author" />

      <div v-if="description || (chapters && chapters.length > 0)" class="overview">
        <p v-if="description" class="description">{{ description }}</p>
        <LectureOutline
          v-if="chapters && chapters.length > 0"
          interactive
          :chapters="chapters"
          @seek="onChapterTap"
        />
      </div>

      <LanguageSelector
        v-if="availableLanguages.length > 1"
        v-model:active="activeLanguages"
        :languages="availableLanguages"
        :allow-multiple="allowMultipleLanguages"
        @translate="(code) => emit('translate', code)"
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
        :multi-speaker-languages="multiSpeakerLanguages"
        :should-highlight-current-sentence="
          enableActiveProminence !== false && shouldHighlightCurrentSentence
        "
        :enable-active-prominence="enableActiveProminence !== false"
        @seek="(pos) => emit('seek', pos)"
        @chapter-seek="onChapterTap"
        @text-selected="(e) => emit('text-selected', e)"
        @note-tapped="(e) => emit('note-tapped', e)"
        @pick-start="emit('pick-start')"
      />
    </IonContent>
  </IonModal>
</template>

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

.overview {
  /* IonContent has no default content padding in the immersive reader, so
     the description + chapters would otherwise run edge-to-edge. Match the
     transcript body's 16px gutter. */
  display: block;
  padding-inline: 16px;
}

.description {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--ion-text-color, #222);
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

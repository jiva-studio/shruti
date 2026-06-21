<template>
  <!--
    Two render modes, like VerseCard:
      • transcript text known  → full quote card (player + text + attrs)
      • text absent / not yet  → the small CitationChip, reused as-is.
    The store read is reactive, so a chip upgrades to the card the moment
    the `cite_transcript` payload lands (it may arrive after the marker).
  -->
  <!-- Block wrapper so the chip sits on its own line (own line + a line
       after it), matching the card / quote — a citation never flows
       inline mid-sentence. -->
  <div v-if="!snippetText" class="citation-chip-line">
    <CitationChip :track-id="trackId" :start-ms="startMs" :end-ms="endMs" :caption="caption" />
  </div>
  <!-- Fixed-height skeleton held until BOTH the snippet text and the
       async track/author metadata are ready, so the card reveals at its
       final size in one step instead of growing as the meta-block lands
       (issue #926). The skeleton's height matches the real card so there
       is no reflow on reveal. -->
  <AccentFrame
    v-else-if="!metaLoaded"
    class="citation-card citation-card--loading"
    aria-hidden="true"
  >
    <div class="citation-skeleton">
      <span class="citation-skeleton-player" />
      <span class="citation-skeleton-line citation-skeleton-line--text" />
      <span class="citation-skeleton-line citation-skeleton-line--text short" />
      <span class="citation-skeleton-line citation-skeleton-line--meta" />
    </div>
  </AccentFrame>
  <AccentFrame
    v-else
    class="citation-card"
    role="button"
    tabindex="0"
    :aria-label="trackTitle || $t('chat.citationDetailsTitle')"
    @click="emit('activate')"
    @keydown.enter.space.prevent="emit('activate')"
  >
    <AutoHeight>
      <ExcerptCard
        :text="displayHtml"
        :author-name="authorName"
        :track-title="trackTitle"
        :reference="referenceLabel"
        :track-date="trackDate"
      >
        <template #player>
          <!-- The player owns its own taps (play / seek); stop the bubble
               so tapping it doesn't also fire the card's activate. -->
          <NotesInlinePlayer :note="playerRef" :active="active" @click.stop />
        </template>
      </ExcerptCard>
    </AutoHeight>
  </AccentFrame>

  <TranslationNotice v-if="isMt" v-model:show-original="showOriginal" />
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { renderExcerptHtml } from "@lectorium/composables/chatMarkers.js"
import { formatReference } from "@lib/domain/services/references.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import type { ChatCiteSnippet } from "@lib/domain/chatMessage.js"
import { ExcerptCard } from "@ui/components/excerpt/index.js"
import NotesInlinePlayer from "@lectorium/views/Notes/NotesInlinePlayer.vue"
import { citationExcerptId } from "../composables/useCitationSnippet.js"
import { useCitationMeta } from "../composables/useCitationMeta.js"
import { useTranslatable } from "../composables/useTranslatable.js"
import CitationChip from "./CitationChip.vue"
import TranslationNotice from "./TranslationNotice.vue"
import AutoHeight from "./AutoHeight.vue"
import AccentFrame from "./AccentFrame.vue"

const props = defineProps<{
  trackId: string
  startMs: number
  endMs: number
  /** LLM-generated snippet caption from the marker. Used by the chip
   *  fallback; the full card shows the transcript text instead. */
  caption?: string
  /** Transcript snippet from the owning message's `cites` map; absent ⇒
   *  chip fallback. */
  body?: ChatCiteSnippet
  /** False pauses the inline player (e.g. host carousel slide off-screen). */
  active?: boolean
}>()

/** Tapping the card asks the HOST to act (open the citation action sheet).
 *  A leaf card never owns that dialog — onboarding reuses this card with no
 *  listener, so tapping it does nothing. */
const emit = defineEmits<{ activate: [] }>()

const appLanguage = useAppLanguage()
const dictionaries = useDictionariesStore()

/** Transcript snippet pushed by the server ahead of the marker. Null
 *  until it lands (or forever for pre-feature history) → chip fallback. */
const snippet = computed(() => props.body ?? null)
const snippetText = computed<string | null>(() => snippet.value?.text ?? null)
// Translation toggle (show original ↔ machine translation), shared with
// CommentaryCard.
const { isMt, showOriginal, displayText } = useTranslatable(() => snippet.value)

/** Transcript snippet rendered through the shared excerpt-markdown pipeline
 *  (inline emphasis/bold + `>` block quotes), same as CommentaryCard, so a
 *  quoted śloka or stray markdown renders instead of printing literally.
 *  Consumed by `ExcerptCard` → `HighlightText` via `v-html`. */
const displayHtml = computed<string>(() => renderExcerptHtml(displayText.value))

// Display metadata only — the action sheet is the host's (see CitationActionSheet).
// `metaLoaded` gates the skeleton → card reveal (issue #926).
const { track, metaLoaded, trackTitle, authorName } = useCitationMeta(() => ({
  trackId: props.trackId,
  startMs: props.startMs,
  endMs: props.endMs,
  caption: props.caption,
}))

const audioPath = computed<string>(() => {
  if (!track.value) return ""
  const variant = pickPlayableVariant(track.value)
  return variant?.audio?.path ?? ""
})

/**
 * Player ref for the reused NotesInlinePlayer. `noteId` doubles as the
 * excerpt cache id — set to the chat-citation id so the cut excerpt and
 * predicted CDN URL match what the chip's `useCitationSnippet` produces
 * (same public/shares/audio/chat-cite-*.mp3 object — no double cut).
 * Passed as a computed so the player reads `sourceKey` fresh once the
 * track (hence `audioPath`) resolves — see the useExcerptWaveform getter.
 */
const playerRef = computed(() => ({
  noteId: citationExcerptId({ trackId: props.trackId, startMs: props.startMs, endMs: props.endMs }),
  trackId: props.trackId,
  sourceKey: audioPath.value,
  timeStart: props.startMs,
  timeEnd: props.endMs,
}))

const referenceLabel = computed<string>(() => {
  const first = track.value?.references?.[0]
  if (!first) return ""
  return formatReference(first, dictionaries.sourcesById, appLanguage.value)
})

const trackDate = computed<string>(() => track.value?.date || "")

onMounted(() => {
  // Sources are needed to format the shloka reference, like the Notes
  // list does; one-shot full load, cached across the session.
  void dictionaries.ensureLoaded()
})
</script>

<style scoped>
/* Chip fallback on its own line — block so the prose after the citation
 * starts on a new line, like the card / quote. */
.citation-chip-line {
  display: block;
  margin: 6px 0;
}

.citation-card {
  margin: 10px 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  --excerpt-body-padding: 8px 12px 10px;
}

.citation-card :deep(.notes-inline-player) {
  margin-bottom: 0;
  border-radius: 0;
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}

/* Inline markdown styles for the transcript text (renderExcerptHtml / marked
 * output), mirrored from CommentaryCard. :deep penetrates the scope into the
 * v-html span rendered by HighlightText. */
.citation-card :deep(strong) {
  font-weight: 600;
}
.citation-card :deep(em) {
  font-style: italic;
}
.citation-card :deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}
.citation-card :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}
/* `> …` block quote (a śloka quoted inside the snippet): its own line,
 * italic, with a quiet left rule — no literal `>`. */
.citation-card :deep(.excerpt-quote) {
  margin: 0.6em 0;
  padding-left: 12px;
  border-left: 3px solid rgba(var(--ion-color-primary-rgb), 0.4);
  font-style: italic;
  line-height: 1.4;
}

/* Loading placeholder: a fixed-height shimmer that approximates the real
 * card (player strip + two text lines + a meta line) so the reveal causes
 * no layout shift. Non-interactive while it stands in. */
.citation-card--loading {
  cursor: default;
}
.citation-skeleton {
  display: flex;
  flex: 1;
  flex-direction: column;
}
.citation-skeleton-player {
  height: 40px;
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}
.citation-skeleton-line {
  height: 12px;
  margin: 8px 12px 0;
  border-radius: 6px;
  background: linear-gradient(
    90deg,
    rgba(120, 120, 120, 0.12),
    rgba(120, 120, 120, 0.06),
    rgba(120, 120, 120, 0.12)
  );
}
.citation-skeleton-line--text.short {
  width: 65%;
}
.citation-skeleton-line--meta {
  width: 40%;
  align-self: flex-end;
  margin-right: 12px;
  margin-bottom: 10px;
}
</style>

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
    @click="openActions"
    @keydown.enter.space.prevent="openActions"
  >
    <AutoHeight>
      <ExcerptCard
        :text="displayText"
        :author-name="authorName"
        :track-title="trackTitle"
        :reference="referenceLabel"
        :track-date="trackDate"
      >
        <template #player>
          <!-- The player owns its own taps (play / seek); stop the bubble
               so tapping it doesn't also open the action sheet. -->
          <NotesInlinePlayer :note="playerRef" @click.stop />
        </template>
      </ExcerptCard>
    </AutoHeight>

    <IonActionSheet
      :is-open="actionSheetOpen"
      :header="trackTitle"
      :buttons="actionSheetButtons"
      @did-dismiss="actionSheetOpen = false"
    />
  </AccentFrame>

  <TranslationNotice v-if="isMt" v-model:show-original="showOriginal" />
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { formatReference } from "@lib/domain/services/references.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import type { ChatCiteSnippet } from "@lib/domain/chatMessage.js"
import { ExcerptCard } from "@ui/components/excerpt/index.js"
import NotesInlinePlayer from "@shruti/views/Notes/NotesInlinePlayer.vue"
import { citationExcerptId } from "../composables/useCitationSnippet.js"
import { useCitationActions } from "../composables/useCitationActions.js"
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
}>()

const appLanguage = useAppLanguage()
const dictionaries = useDictionariesStore()

/** Transcript snippet pushed by the server ahead of the marker. Null
 *  until it lands (or forever for pre-feature history) → chip fallback. */
const snippet = computed(() => props.body ?? null)
const snippetText = computed<string | null>(() => snippet.value?.text ?? null)
// Translation toggle (show original ↔ machine translation), shared with
// CommentaryCard.
const { isMt, showOriginal, displayText } = useTranslatable(() => snippet.value)

// Metadata load + the Save/Studio/Playlist action sheet are shared with the
// chip fallback. `metaLoaded` gates the skeleton → card reveal (issue #926).
const {
  track,
  metaLoaded,
  trackTitle,
  authorName,
  actionSheetOpen,
  actionSheetButtons,
  openActions,
} = useCitationActions(
  () => ({
    trackId: props.trackId,
    startMs: props.startMs,
    endMs: props.endMs,
    caption: props.caption,
  }),
  // Card mode only renders with the snippet text known; pass it so a saved
  // note carries the real fragment, not a re-fetch / the caption.
  { snippetText: () => snippetText.value }
)

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

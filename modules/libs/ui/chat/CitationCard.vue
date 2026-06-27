<template>
  <!--
    Two render modes, like VerseCard:
      • transcript text known  → full quote card (player + text + attrs)
      • text absent / not yet  → a small inline chip fallback.
    The body is reactive, so a chip upgrades to the card the moment the
    `cite_transcript` payload lands (it may arrive after the marker).
  -->
  <!-- Block wrapper so the chip sits on its own line (own line + a line
       after it), matching the card / quote — a citation never flows
       inline mid-sentence. -->
  <div v-if="!snippetText" class="citation-chip-line">
    <!-- No-body fallback. The Ionic/audio-coupled CitationChip is a HOST
         concern; a pure card renders a plain caption pill here (or the
         caller fills the `#chip` slot with its own interactive chip). -->
    <slot name="chip">
      <span class="citation-chip-fallback">{{ caption || chipFallbackLabel }}</span>
    </slot>
  </div>
  <!-- Fixed-height skeleton held until BOTH the snippet text and the
       async track/author metadata are ready (`metaReady`), so the card
       reveals at its final size in one step instead of growing as the
       meta-block lands (issue #926). The skeleton's height matches the
       real card so there is no reflow on reveal. The parent owns metadata
       loading and tells the card when it is ready. -->
  <AccentFrame
    v-else-if="!metaReady"
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
    :aria-label="trackTitle || cardLabel"
    @click="emit('activate')"
    @keydown.enter.space.prevent="emit('activate')"
  >
    <AutoHeight>
      <ExcerptCard
        :text="bodyHtml ?? ''"
        :language="language"
        :author-name="authorName"
        :track-title="trackTitle"
        :reference="reference"
        :track-date="trackDate"
      >
        <!-- Audio is a HOST concern: the parent provides the player (URL
             resolution + excerpt cut + playback) through this pass-through
             slot. The card never resolves URLs or cuts excerpts itself. -->
        <template #player>
          <slot name="player" />
        </template>
      </ExcerptCard>
    </AutoHeight>
  </AccentFrame>

  <TranslationNotice
    v-if="isMt"
    :show-original="showOriginal"
    @update:show-original="emit('update:show-original', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { ChatCiteSnippet } from "@lib/domain/chatMessage.js"
import { ExcerptCard } from "@lib/ui/excerpt/index.js"
import TranslationNotice from "./TranslationNotice.vue"
import AutoHeight from "./AutoHeight.vue"
import AccentFrame from "./AccentFrame.vue"

const props = withDefaults(
  defineProps<{
    /** LLM-generated snippet caption from the marker. Used by the chip
     *  fallback; the full card shows the transcript text instead. */
    caption?: string
    /** Transcript snippet from the owning message's `cites` map; absent ⇒
     *  chip fallback. */
    body?: ChatCiteSnippet
    /** Resolved lecture title (content language). Loaded by the parent. */
    trackTitle?: string
    /** Resolved author name (UI language). Loaded by the parent. */
    authorName?: string
    /** Lecture date, e.g. "1972-08-14". Loaded by the parent. */
    trackDate?: string
    /** Pre-formatted shloka reference label (e.g. "ŚB 1.2.3"). The parent
     *  formats it — the card never touches the sources dictionary. */
    reference?: string
    /** Content language for the rendered excerpt text (HighlightText). */
    language?: string
    /** Gates the skeleton → card reveal. The parent flips this true once
     *  its metadata lookup settles (#926). Defaults true so a host that
     *  has no async meta (e.g. the focus bubble) reveals immediately. */
    metaReady?: boolean
    /** Fallback aria-label for the card when no title is known. The parent
     *  supplies the localized string (was `$t("chat.citationDetailsTitle")`). */
    cardLabel?: string
    /** Fallback label for the no-body chip when the marker omitted a
     *  caption. Localized by the parent. */
    chipFallbackLabel?: string
    /** Transcript snippet pre-rendered to HTML by the host (renderExcerptHtml
     *  over the active translation). Consumed by `ExcerptCard` → `HighlightText`
     *  via `v-html`. */
    bodyHtml?: string
    /** True when the snippet is a machine translation with an original to flip
     *  to — gates the TranslationNotice. Computed by the host. */
    isMt?: boolean
    /** Machine-translation toggle state, owned by the host. */
    showOriginal?: boolean
  }>(),
  { metaReady: true, isMt: false, showOriginal: false }
)

/** Tapping the card asks the HOST to act (open the citation action sheet).
 *  A leaf card never owns that dialog — onboarding reuses this card with no
 *  listener, so tapping it does nothing. `update:show-original` notifies the
 *  host when the user flips the translation toggle. */
const emit = defineEmits<{ activate: []; "update:show-original": [value: boolean] }>()

/** Transcript snippet pushed by the server ahead of the marker. Null
 *  until it lands (or forever for pre-feature history) → chip fallback. */
const snippet = computed(() => props.body ?? null)
const snippetText = computed<string | null>(() => snippet.value?.text ?? null)
</script>

<style scoped>
/* Chip fallback on its own line — block so the prose after the citation
 * starts on a new line, like the card / quote. */
.citation-chip-line {
  display: block;
  margin: 6px 0;
}

/* No-body fallback pill: a quiet, non-interactive caption. The interactive
 * play/long-press chip is the host's job (it owns audio + Ionic). */
.citation-chip-fallback {
  display: inline-flex;
  align-items: center;
  height: 22px;
  margin: 3px 2px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--ion-color-medium);
  color: var(--ion-color-medium);
  font-size: 12px;
  line-height: 1;
  max-width: 18em;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  vertical-align: middle;
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
 * italic, no literal `>`. No left rule — the card's own accent bar already
 * frames it; a second stripe on the nested verse reads as double-nesting. */
.citation-card :deep(.excerpt-quote) {
  margin: 0.6em 0;
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

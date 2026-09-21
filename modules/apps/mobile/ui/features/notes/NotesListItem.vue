<script lang="ts" setup>
import { ExcerptCard } from "@lib/ui/excerpt/index.js"
import AccentFrame from "@lib/ui/chat/AccentFrame.vue"

defineProps<{
  noteId: string
  text: string
  language?: string
  authorName?: string
  trackTitle?: string
  trackDate?: string
  reference?: string
}>()

defineEmits<{ click: [noteId: string] }>()
</script>

<template>
  <!--
    A saved note IS an audio citation — render it with the exact same frame
    as the chat citation card (AccentFrame + the shared ExcerptCard), so the
    two surfaces look identical. This wrapper owns only the row affordance
    (tap → action sheet); chat's CitationCard frames the same card the same way.
  -->
  <div
    class="note"
    role="button"
    tabindex="0"
    @click="$emit('click', noteId)"
    @keydown.enter.space.prevent="$emit('click', noteId)"
  >
    <AccentFrame>
      <ExcerptCard
        :text="text"
        :language="language"
        :author-name="authorName"
        :track-title="trackTitle"
        :track-date="trackDate"
        :reference="reference"
      >
        <template #player>
          <slot name="player" />
        </template>
      </ExcerptCard>
    </AccentFrame>
  </div>
</template>

<style scoped>
/* Mirror the chat citation card (CitationCard.vue): body inset + a flush,
   primary-tinted inline player. The AccentFrame supplies the bar + tint. */
.note {
  margin: 1rem 16px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  --excerpt-body-padding: 8px 12px 10px;
}
.note:first-child {
  margin-top: 0;
}
.note :deep(.notes-inline-player) {
  margin-bottom: 0;
  border-radius: 0;
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}

/* Inline markdown styles for the snippet text (renderExcerptHtml / marked
 * output), mirrored from the chat CitationCard so a saved note renders its
 * emphasis / code / quote identically. :deep penetrates the scope into the
 * v-html span rendered by HighlightText. */
.note :deep(strong) {
  font-weight: 600;
}
.note :deep(em) {
  font-style: italic;
}
.note :deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}
.note :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}
/* `> …` block quote (a śloka quoted inside the snippet): its own line,
 * italic, no literal `>`. No left rule — the AccentFrame's accent bar
 * already frames it. */
.note :deep(.excerpt-quote) {
  margin: 0.6em 0;
  font-style: italic;
  line-height: 1.4;
}
</style>

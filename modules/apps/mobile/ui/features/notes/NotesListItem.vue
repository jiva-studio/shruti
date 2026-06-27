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
</style>

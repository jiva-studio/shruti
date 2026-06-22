<template>
  <IonItem lines="none" class="note" button :detail="false" @click="$emit('click', noteId)">
    <!--
      The body (player + text + attribution) is the shared ExcerptCard,
      reused verbatim by the chat citation card. The IonItem here owns
      only the row affordance (tap → action sheet) and the left-border
      frame; chat frames the same card as a quote instead.
    -->
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
  </IonItem>
</template>

<script lang="ts" setup>
import { IonItem } from "@ionic/vue"
import { ExcerptCard } from "@lib/ui/excerpt/index.js"

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
.note {
  border-left: 5px solid;
  border-color: var(--ion-color-primary-tint);
  margin: 1rem 0rem;

  /* Justified body text is a Notes-list-only treatment (it predates the
     shared ExcerptCard). Kept here, on the row, so the chat citation card
     — which reuses ExcerptCard — does NOT inherit it. `text-align` /
     `hyphens` cascade to the text inside ExcerptCard. */
  text-align: justify;
  text-justify: inter-word;
  hyphens: auto;
  -moz-hyphens: auto;

  /* Снимаем дефолтный ripple у IonItem[button]. Тап по заметке открывает
     action-sheet — визуального echo тут не нужно, он мешает. */
  --ripple-color: rgba(0, 0, 0, 0);
}
</style>

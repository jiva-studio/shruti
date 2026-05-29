<template>
  <div class="excerpt-card">
    <!--
      Caller-supplied audio player rendered above the text — e.g. the
      inline waveform excerpt player. Injected via the `#player` slot so
      this UI-layer component stays free of @shruti / @lib types.
    -->
    <slot name="player" />

    <HighlightText v-if="text" :text="text" :lang="language" />

    <div v-if="authorName || titleText || refDateText" class="meta-block">
      <div v-if="authorName" class="author">{{ authorName }}</div>
      <div v-if="titleText" class="title">{{ titleText }}</div>
      <div v-if="refDateText" class="meta">{{ refDateText }}</div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue"
import { HighlightText } from "@ui/primitives/index.js"

/**
 * Presentational excerpt body shared by the Notes list and the chat
 * citation card: an audio player (injected via `#player`), the excerpt
 * text, and the attribution block (author / lecture title / shloka
 * reference · date). Dumb on purpose — every value is a resolved prop,
 * so each host (Notes controller / chat CitationCard) owns its own data
 * resolution and framing (`.note` row border vs the chat quote frame).
 */
const props = defineProps<{
  text: string
  language?: string
  authorName?: string
  trackTitle?: string
  trackDate?: string
  reference?: string
}>()

const titleText = computed<string>(() => props.trackTitle?.trim() ?? "")
// Шлока + дата на одной строке. Разделитель — middle-dot (U+00B7).
const refDateText = computed<string>(() =>
  [props.reference, props.trackDate]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" · ")
)
</script>

<style scoped>
.excerpt-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.25rem 0;
  width: 100%;

  text-align: justify;
  text-justify: inter-word;
  hyphens: auto;
  -moz-hyphens: auto;
}

.meta-block {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.author {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--ion-color-medium);
  text-align: right;
  line-height: 1.2;
}

.title {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--ion-color-medium);
  text-align: right;
  line-height: 1.2;
}

.meta {
  font-size: 0.75rem;
  color: var(--ion-color-medium);
  text-align: right;
  line-height: 1.2;
}
</style>

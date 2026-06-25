<template>
  <CitationCard
    :caption="caption"
    :body="body"
    :body-html="bodyHtml"
    :track-title="body?.trackTitle"
    :author-name="body?.authorName"
    :track-date="body?.trackDate"
    :reference="reference"
    :is-mt="isMt"
    :show-original="showOriginal"
    :language="language"
    @update:show-original="showOriginal = $event"
  >
    <template v-if="body" #player>
      <WebExcerptPlayer
        :note-id="noteId"
        :source-key="sourceKey"
        :time-start="timeStart"
        :time-end="timeEnd"
      />
    </template>
  </CitationCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTranslatable } from '@lib/chat/useTranslatable.js'
import { renderExcerptHtml } from '@lib/chat/chatMarkers.js'
import CitationCard from '@lib/ui/chat/CitationCard.vue'
import WebExcerptPlayer from './WebExcerptPlayer.vue'
import type { CitationPayload } from './types/chat'

const props = defineProps<{
  trackId: string
  startMs: number
  endMs: number
  caption?: string
  body?: CitationPayload
  language?: string
}>()

const snippet = computed(() => props.body ?? null)
const reference = computed(() => props.body?.references?.[0]?.label)
const { isMt, showOriginal, displayText } = useTranslatable(() => snippet.value)
const bodyHtml = computed<string>(() => renderExcerptHtml(displayText.value))

const noteId = computed(() => `chat-cite-${props.trackId}-${props.startMs}-${props.endMs}`)
const sourceKey = computed(() => `public/tracks/${props.trackId}/audio/original.mp3`)
const timeStart = computed(() => props.startMs)
const timeEnd = computed(() => props.endMs)
</script>

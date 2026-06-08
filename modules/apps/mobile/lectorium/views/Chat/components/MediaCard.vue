<template>
  <!--
    Media result widget: a video (or audio) file on top, the server-built
    transcript below in a quote-style block (left accent stripe + soft
    primary tint + rounded), matching CitationCard / the chat blockquote.
    Renders only when the `media` SSE payload landed on the message (the
    parent guards with `v-if`, but we also no-op if the payload is missing
    so a stray marker never crashes the bubble).
  -->
  <article v-if="payload" class="media-card">
    <video
      v-if="payload.type === 'video'"
      class="media-card-video"
      controls
      playsinline
      preload="metadata"
      :poster="posterUrl"
      :src="fileUrl"
    />
    <!-- Audio result: full-file player. A plain controls element (the file
         is a whole-file URL, not an excerpt cut) — no waveform/excerpt
         machinery needed here. -->
    <audio v-else class="media-card-audio" controls preload="metadata" :src="fileUrl" />

    <div class="media-card-body">
      <p v-if="payload.title" class="media-card-caption">{{ payload.title }}</p>
      <p v-if="payload.text" class="media-card-text">{{ payload.text }}</p>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import type { MediaPayload } from "@lib/domain/chatMessage.js"

const props = defineProps<{
  /** Server-streamed media payload from the `media` SSE action, read off
   *  `message.media[token.mediaId]`. Optional so the parent can pass an
   *  unresolved id without the card throwing — it renders nothing then. */
  payload?: MediaPayload
}>()

const app = useLectorium()

// `payload.url` is a RELATIVE storage path (from the bucket root, e.g.
// `public/media/<id>.mp4`); resolve it to the active server's CDN URL.
const fileUrl = computed(() => (props.payload ? app.storagePublicUrl.get(props.payload.url) : ""))

// Poster = the file path with its extension swapped to `.jpg` (server
// convention: each media file ships a sibling thumbnail). Only meaningful
// for video; audio ignores it.
const posterUrl = computed(() => {
  if (!props.payload) return ""
  const jpg = props.payload.url.replace(/\.[^./]+$/, ".jpg")
  return app.storagePublicUrl.get(jpg)
})
</script>

<style scoped>
/* Block-level card sitting between prose tokens, like CitationCard. */
.media-card {
  display: block;
  margin: 10px 0;
}

.media-card-video {
  display: block;
  width: 100%;
  max-height: 60vh;
  border-radius: 8px;
  background: #000;
}

.media-card-audio {
  display: block;
  width: 100%;
}

/* Transcript block — quote-style frame matching the chat blockquote /
 * CitationCard: left accent bar + soft primary tint + rounded. */
.media-card-body {
  margin-top: 8px;
  padding: 8px 12px 10px;
  border-left: 3px solid var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.06);
  border-radius: 4px;
  line-height: 1.45;
}

/* Server-built label ("speaker · date") — rendered verbatim. */
.media-card-caption {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ion-color-primary);
}

.media-card-text {
  margin: 0;
  white-space: pre-wrap;
}
</style>

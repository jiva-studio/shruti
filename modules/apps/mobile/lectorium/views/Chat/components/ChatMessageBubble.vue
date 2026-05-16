<template>
  <div :class="['bubble-row', message.role]">
    <div :class="['bubble', message.role, { streaming: message.streaming }]">
      <template v-if="message.role === 'user'">
        <span class="user-text">{{ message.content }}</span>
      </template>
      <template v-else>
        <span v-if="message.content.length === 0 && message.streaming" class="thinking">
          <span class="dot" />
          <span class="dot" />
          <span class="dot" />
        </span>
        <template v-else>
          <template v-for="(token, idx) in tokens" :key="idx">
            <span v-if="token.kind === 'text'" v-html="token.html" />
            <CitationChip
              v-else-if="token.kind === 'cite'"
              :track-id="token.trackId"
              :start-ms="token.startMs"
              :end-ms="token.endMs"
              :caption="token.caption"
            />
            <LectureCard v-else-if="token.kind === 'card'" :track-id="token.trackId" />
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { parseChatMarkers } from "../composables/useMarkerParser.js"
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"
import CitationChip from "./CitationChip.vue"
import LectureCard from "./LectureCard.vue"

const props = defineProps<{ message: ChatMessage }>()

const tokens = computed(() => {
  if (props.message.role !== "assistant") return []
  return parseChatMarkers(props.message.content)
})
</script>

<style scoped>
.bubble-row {
  display: flex;
  margin: 6px 0;
  padding: 0 12px;
}

.bubble-row.user {
  justify-content: flex-end;
}

.bubble-row.assistant {
  justify-content: flex-start;
}

.bubble {
  font-size: 15px;
  line-height: 1.45;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

/* Only the user side renders as a chat bubble — the assistant answer is
 * full-width prose (Claude pattern). Keeps the page wider for reading
 * long replies, cards, and citation chips without an enclosing pill. */
.bubble.user {
  max-width: 86%;
  padding: 10px 14px;
  border-radius: 18px;
  border-bottom-right-radius: 6px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.bubble.assistant {
  color: var(--ion-text-color);
  width: 100%;
}

.user-text {
  white-space: pre-wrap;
}

.thinking {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 4px 0;
}

.thinking .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ion-color-step-500, #9a9a9a);
  animation: thinking-pulse 1.2s ease-in-out infinite;
}

.thinking .dot:nth-child(2) {
  animation-delay: 0.15s;
}

.thinking .dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes thinking-pulse {
  0%,
  60%,
  100% {
    opacity: 0.4;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

/* Inline markdown styles (marked.parseInline output): keep them
 * scoped-safe by allowing :deep into the v-html span tree. */
.bubble.assistant :deep(strong) {
  font-weight: 600;
}

.bubble.assistant :deep(em) {
  font-style: italic;
}

.bubble.assistant :deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}

.bubble.assistant :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}
</style>

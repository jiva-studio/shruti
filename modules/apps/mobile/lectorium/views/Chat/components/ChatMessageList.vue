<template>
  <div class="chat-message-list">
    <ChatMessageBubble
      v-for="msg in messages"
      :key="msg.id"
      :message="msg"
      @pick-chapter="$emit('pick-chapter', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"
import ChatMessageBubble from "./ChatMessageBubble.vue"

defineProps<{ messages: readonly ChatMessage[] }>()
defineEmits<{
  "pick-chapter": [
    args: {
      trackId: string
      item: { startMs: number; title: string }
      nextItem: { startMs: number; title: string } | null
    },
  ]
}>()
</script>

<style scoped>
.chat-message-list {
  display: flex;
  flex-direction: column;
  padding: 12px 0 8px;
  min-height: 100%;
}
</style>

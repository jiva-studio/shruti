<template>
  <div class="chat-message-list">
    <ChatMessageBubble v-for="msg in messages" :key="msg.id" :message="msg" />
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"
import ChatMessageBubble from "./ChatMessageBubble.vue"

defineProps<{ messages: readonly ChatMessage[] }>()
</script>

<style scoped>
.chat-message-list {
  display: flex;
  flex-direction: column;
  padding: 12px 0 8px;
  min-height: 100%;
}
</style>

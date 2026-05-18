<template>
  <div class="chat-message-list">
    <template v-for="(msg, i) in messages" :key="msg.id">
      <ChatMessageBubble :message="msg" @pick-chapter="$emit('pick-chapter', $event)" />
      <FollowupChips
        v-if="
          i === lastAssistantIndex && !msg.streaming && msg.followups && msg.followups.length > 0
        "
        :followups="msg.followups"
        @pick="$emit('pick-followup', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"
import ChatMessageBubble from "./ChatMessageBubble.vue"
import FollowupChips from "./FollowupChips.vue"

const props = defineProps<{ messages: readonly ChatMessage[] }>()
defineEmits<{
  "pick-chapter": [
    args: {
      trackId: string
      item: { startMs: number; title: string }
      nextItem: { startMs: number; title: string } | null
    },
  ]
  "pick-followup": [text: string]
}>()

/** Index of the last *finalised* assistant message — chips render under
 *  this row only. The currently-streaming placeholder is excluded so
 *  chips don't flash before the message is fully parsed. */
const lastAssistantIndex = computed<number>(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const m = props.messages[i]
    if (m.role === "assistant" && !m.streaming) return i
  }
  return -1
})
</script>

<style scoped>
.chat-message-list {
  display: flex;
  flex-direction: column;
  padding: 12px 0 8px;
  min-height: 100%;
}
</style>

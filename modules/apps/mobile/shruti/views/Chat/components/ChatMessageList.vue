<template>
  <div class="chat-message-list">
    <template v-for="(msg, i) in messages" :key="msg.id">
      <ChatMessageBubble
        :message="msg"
        :is-last="i === messages.length - 1"
        :focus-suggestions="msg.focus ? (msg.followups ?? null) : null"
        :focus-loading="msg.focus ? loadingFocusIds?.has(msg.id) === true : false"
        @pick-chapter="$emit('pick-chapter', $event)"
        @retry="$emit('retry', $event)"
        @pick-suggestion="$emit('pick-suggestion', $event)"
      />
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

const props = defineProps<{
  messages: readonly ChatMessage[]
  /** Set of focus-message ids whose `/questions` round-trip is
   *  in-flight. Each focus card looks itself up in here to decide
   *  between "loading pill" vs "chips" vs "fallback". */
  loadingFocusIds?: ReadonlySet<string>
}>()
defineEmits<{
  "pick-chapter": [
    args: {
      trackId: string
      item: { startMs: number; title: string }
      nextItem: { startMs: number; title: string } | null
    },
  ]
  "pick-followup": [text: string]
  "pick-suggestion": [text: string]
  retry: [messageId: string]
}>()

/** Index of the last *finalised* assistant message, IF it's also the
 *  very last item in the list. Two reasons for that second check:
 *
 *   - It hides the previous turn's chips the moment the user sends a
 *     new message (last item is now the user bubble), instead of
 *     keeping them visible through the streaming of the new reply
 *     and then ripping them out at finalisation. Removing chips
 *     after the new reply lands would shrink the content ABOVE the
 *     user bubble and visually pull the whole conversation upward
 *     — the glitch we want to avoid.
 *   - It still excludes the streaming placeholder (which is the last
 *     item during the new reply); chips for the previous turn would
 *     otherwise sit between the user bubble and the streaming dots,
 *     which looks odd.
 *
 *  Net effect: chips appear once per turn, on the final assistant
 *  message, and only when there's no in-flight reply after it.
 *  Removal happens at the boundary of "user sent a new message"
 *  rather than at the boundary of "new reply finished". */
const lastAssistantIndex = computed<number>(() => {
  const last = props.messages[props.messages.length - 1]
  if (!last || last.role !== "assistant" || last.streaming) return -1
  return props.messages.length - 1
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

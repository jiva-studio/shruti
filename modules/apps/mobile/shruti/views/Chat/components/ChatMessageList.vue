<script setup lang="ts">
import { computed } from "vue"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"
import ChatMessageBubble from "./ChatMessageBubble.vue"
import ChatChips from "./ChatChips.vue"

const props = defineProps<{
  messages: readonly ChatMessage[]
  /** Set of focus-message ids whose `/questions` round-trip is
   *  in-flight. Each focus card looks itself up in here to decide
   *  between "loading pill" vs "chips" vs "fallback". */
  loadingFocusIds?: ReadonlySet<string>
  /** Mirrors `useChatStore.isComposeBlocked`. Both chip rows in the thread
   *  (follow-ups and the focus card's questions) send a turn on tap, so
   *  they go dead with the composer while the daily quota is exhausted. */
  quotaLocked?: boolean
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
  "send-suggestion": [text: string]
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

<template>
  <div class="chat-message-list">
    <div
      v-for="(msg, i) in messages"
      :key="msg.id"
      :class="[
        'msg-slot',
        {
          tail: i === messages.length - 1 && msg.role === 'assistant',
          lead: i === 0 && msg.role === 'assistant',
        },
      ]"
    >
      <ChatMessageBubble
        :message="msg"
        :is-last="i === messages.length - 1"
        :focus-suggestions="msg.focus ? (msg.followups ?? null) : null"
        :focus-loading="msg.focus ? loadingFocusIds?.has(msg.id) === true : false"
        :quota-locked="quotaLocked"
        @pick-chapter="$emit('pick-chapter', $event)"
        @retry="$emit('retry', $event)"
        @send-suggestion="$emit('send-suggestion', $event)"
      />
      <ChatChips
        v-if="
          i === lastAssistantIndex && !msg.streaming && msg.followups && msg.followups.length > 0
        "
        class="followups"
        :items="msg.followups"
        align="end"
        aria-label-key="chat.followupAriaLabel"
        :disabled="quotaLocked"
        @pick="$emit('pick-followup', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.chat-message-list {
  display: flex;
  flex-direction: column;
  padding: 12px 0 8px;
  min-height: 100%;
}

/* Non-tail slots stay invisible to layout — bubble-row and followup
 * chips render as if there were no wrapper, preserving the prior flex
 * column flow of the message list. */
.msg-slot {
  display: contents;
}

/* A proactive chat opens with an assistant message (the agent speaks
 * first). It renders at scrollTop=0 and — unlike a user bubble, which
 * gets pinned below the fade by `scrollMessageToTop`'s scroll-margin —
 * is never scrolled, so nothing pushes it clear of the fixed-top fade.
 * A short single-message session has no scroll room either, so a scroll
 * fix can't help; only a top inset on the slot can.
 *
 * The inset has to bridge the gap the content padding leaves open: the
 * fade (`.chat-fixed-top`) runs `safe-area + action-row (~52px) +
 * padding-bottom (28px)`, but `.chat-content`'s `--padding-top` only
 * reserves `safe-area + 44px`. So the fade's 28px gradient tail overhangs
 * the content and the opening line tucks under it. Match that 28px tail
 * here so the lead line lands clear of the fade, the same visual spot a
 * user bubble ends up in.
 *
 * Promote the lead slot to a real box (same trick as `.tail`). Placed
 * before `.tail` so a single-message session — lead AND tail — keeps the
 * tail box; only the padding carries over. */
.msg-slot.lead {
  display: block;
  padding-top: 28px;
}

/* The tail slot — last assistant message in the conversation — owns
 * the scroll-room reservation. Becoming a flex column makes the slot
 * itself a real box so its min-height can stretch; bubble + followup
 * chips sit at the top, the buffer falls below the chips.
 *
 * Without this reservation, `scrollMessageToTop` can't pin the user's
 * just-sent question to the viewport top when the answer is shorter
 * than a screen — scrollHeight collapses and the browser yanks the
 * view back to earlier turns.
 *
 * `svh` (small viewport height) is the layout the keyboard leaves us
 * with on mobile. The 200px deduction accounts for the fixed-top fade
 * (~80px), the input bar (~64px), and ~56px safety margin for OS
 * gestures and the just-sent user bubble. */
.msg-slot.tail {
  display: flex;
  flex-direction: column;
  min-height: calc(100svh - 200px);
}

/* Inline follow-up chips sit right-aligned (tapping one sends it as the
 * next user message, and user bubbles live on the right). */
.followups {
  margin: 4px 12px 12px;
}
</style>

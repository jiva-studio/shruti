<template>
  <ChatFocusCard
    v-if="message.focus"
    :data-message-id="message.id"
    :message-id="message.id"
    :focus="message.focus"
    :suggestions="focusSuggestions"
    :suggestions-loading="focusLoading"
    @send-suggestion="$emit('send-suggestion', $event)"
  />
  <div v-else :class="['bubble-row', message.role]" :data-message-id="message.id">
    <div :class="['bubble', message.role, { streaming: message.streaming }]">
      <template v-if="message.role === 'user'">
        <span class="user-text">{{ message.content }}</span>
      </template>
      <template v-else-if="failedKind">
        <InlineNotice
          :kind="noticeKind"
          :title="noticeTitle || undefined"
          :body="noticeBody"
          :cta="noticeCta"
        />
      </template>
      <template v-else>
        <!-- Render whatever prose has streamed so far. -->
        <ChatTokenRenderer
          v-if="message.content.length > 0"
          :message="message"
          @pick-chapter="$emit('pick-chapter', $event)"
        />
        <!-- Keep the thinking indicator up for the WHOLE streaming turn, not
             just until the first token. The server now paints the intro early
             (before the slower grounding + synthesis finishes), so hiding the
             pill on first content left a long gap where the answer looked
             done but more text was still coming. Stays until `streaming`
             flips false (turn finalised). -->
        <StatusPill
          v-if="message.streaming"
          :status-key="message.statusKey"
          :params="message.statusParams"
          :research-questions="message.researchQuestions"
          :research-sources="message.researchSources"
        />
        <span v-if="errorSuffix && !message.streaming" class="truncated-suffix">{{
          errorSuffix
        }}</span>
      </template>
    </div>
    <ChatMessageActions
      v-if="showActions"
      :markdown="exportMarkdown"
      :retry-visible="truncatedRetryVisible"
      :retry-disabled="!canRetry"
      :message-id="message.id"
      :feedback-state="message.feedbackState"
      @retry="onRetry"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"
import ChatMessageActions from "./ChatMessageActions.vue"
import ChatTokenRenderer from "./ChatTokenRenderer.vue"
import StatusPill from "./StatusPill.vue"
import InlineNotice from "@ui/shared/InlineNotice.vue"
import ChatFocusCard from "./ChatFocusCard.vue"
import { useChatExportMarkdown } from "../composables/useChatExportMarkdown.js"
import { useChatMessageStatus } from "../composables/useChatMessageStatus.js"

const props = withDefaults(
  defineProps<{
    message: ChatMessage
    /** Whether this bubble is the last item in the conversation. Only
     *  the trailing failed/truncated message gets a Retry button. */
    isLast?: boolean
    /** Persisted Ask-Sadhu chips for this focus message. `null` means
     *  "fetch hasn't resolved yet" — the card falls back to the static
     *  i18n list. */
    focusSuggestions?: readonly string[] | null
    /** True while the focus message's `/questions` round-trip is in
     *  flight — card renders a loading pill instead of chips. */
    focusLoading?: boolean
  }>(),
  { isLast: false }
)
const emit = defineEmits<{
  /** Forwarded from the inline OutlineCard. The view-level controller
   *  owns prompt assembly + chat.sendMessage. */
  "pick-chapter": [
    args: {
      trackId: string
      item: { startMs: number; title: string }
      nextItem: { startMs: number; title: string } | null
    },
  ]
  /** User tapped Retry on a failed/truncated assistant bubble. */
  retry: [messageId: string]
  /** Forwarded up from ChatFocusCard's suggestion chip taps. */
  "send-suggestion": [text: string]
}>()

const appLanguage = useAppLanguage()

const { exportMarkdown } = useChatExportMarkdown(
  () => props.message,
  () => appLanguage.value
)

const {
  failedKind,
  errorSuffix,
  truncatedRetryVisible,
  canRetry,
  noticeKind,
  noticeTitle,
  noticeBody,
  noticeCta,
  onRetry,
} = useChatMessageStatus({
  message: () => props.message,
  isLast: () => props.isLast,
  onRequestRetry: (id) => emit("retry", id),
})

const showActions = computed<boolean>(
  // Retry now lives in the actions row — keep the row visible whenever
  // the truncated-retry predicate fires, even if the bubble has no
  // exportable markdown yet (edge case: empty truncated stream).
  () => exportMarkdown.value.trim().length > 0 || truncatedRetryVisible.value
)
</script>

<style scoped>
.bubble-row {
  display: flex;
  margin: 6px 0;
  padding: 0 12px;
  /* `scrollIntoView({ block: "start" })` aligns the row's top edge with
   * viewport y = scroll-margin-top. Land the row right below the 52px
   * action row: safe-area + 4 (top pad) + 44 (buttons) + 4 (bottom pad). */
  scroll-margin-top: calc(var(--ion-safe-area-top, 0px) + 56px);
}

.bubble-row.user {
  justify-content: flex-end;
}

.bubble-row.assistant {
  /* Stack the assistant's full-width prose on top of the inline action
   * row. A flex-row layout would shove the actions next to the bubble. */
  flex-direction: column;
  align-items: flex-start;
}

.bubble {
  font-size: 15px;
  line-height: 1.45;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

/* Only the user side renders as a chat bubble — the assistant answer is
 * full-width prose (Claude pattern). */
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

/* Trailing "(прервано)" / "(cut off)" suffix on a message that ended
 * without a clean `done`. */
.bubble.assistant .truncated-suffix {
  color: var(--ion-color-medium);
  font-style: italic;
  font-size: 0.85em;
  white-space: pre;
}
</style>

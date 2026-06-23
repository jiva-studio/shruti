<template>
  <!-- Ask-Sadhu focus message: the tapped fragment IS a citation, so render
       CitationCard directly, with the same fire-and-send chips used for
       answer follow-ups below it. -->
  <div v-if="message.focus" class="focus-row" :data-message-id="message.id">
    <CitationCardContainer
      :track-id="message.focus.trackId"
      :start-ms="message.focus.startMs"
      :end-ms="message.focus.endMs"
      :body="{ text: message.focus.text }"
    />
    <StatusPill v-if="focusLoading" :status-label="t('chat.status.picking_questions')">
      <template #spinner><IonSpinner name="dots" aria-hidden="true" /></template>
    </StatusPill>
    <ChatChips v-else :items="focusChips" align="end" @pick="$emit('send-suggestion', $event)" />
  </div>
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
          :class="{ 'pill-after-content': message.content.length > 0 }"
          :status-label="streamingStatusLabel"
          :research-questions="message.researchQuestions"
          :research-sources="message.researchSources"
        >
          <template #spinner><IonSpinner name="dots" aria-hidden="true" /></template>
        </StatusPill>
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
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"
import ChatMessageActions from "./ChatMessageActions.vue"
import ChatTokenRenderer from "./ChatTokenRenderer.vue"
import StatusPill from "@lib/ui/chat/StatusPill.vue"
import InlineNotice from "@ui/shared/InlineNotice.vue"
import CitationCardContainer from "./CitationCardContainer.vue"
import ChatChips from "./ChatChips.vue"
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
  /** A focus-message discussion chip was tapped — send it as a turn. */
  "send-suggestion": [text: string]
}>()

const { t, te, tm } = useI18n()
const appLanguage = useAppLanguage()

// The status label is resolved here (the container) so StatusPill stays a
// pure view that only renders the string it's given.
const streamingStatusLabel = computed(() => {
  const k = props.message.statusKey
  const path = k ? `chat.status.${k}` : null
  return path && te(path) ? t(path, props.message.statusParams ?? {}) : t("chat.status.thinking")
})

// Focus-message discussion chips: server-generated when available, else the
// static i18n fallback. Empty array hides the row (loading pill shows first).
const fallbackChips = computed<readonly string[]>(() => {
  const raw = tm("chat.focusFallbackSuggestions") as unknown
  if (!Array.isArray(raw)) return []
  return raw.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
})
const focusChips = computed<readonly string[]>(() => {
  const server = props.focusSuggestions
  if (server && server.length > 0) return server
  return fallbackChips.value
})

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
/* Ask-Sadhu focus message: CitationCard + reused ChatChips stacked. Only the
 * horizontal inset (like .bubble-row) and scroll anchor live here. */
.focus-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 12px 0;
  padding: 0 12px;
  scroll-margin-top: calc(var(--ion-safe-area-top, 0px) + 56px);
}

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

/* When the thinking indicator trails already-streamed prose (the intro
 * paints early, then the pill stays while grounding + synthesis finishes),
 * give it clear breathing room from the text above — otherwise the pill
 * sits almost flush against the last line of the intro. No margin in the
 * initial empty-content state, where the pill stands alone. */
.bubble.assistant :deep(.pill-after-content) {
  margin-top: 14px;
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

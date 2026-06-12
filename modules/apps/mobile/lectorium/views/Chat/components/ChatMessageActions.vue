<template>
  <div class="message-actions">
    <button type="button" class="message-action" :aria-label="t('chat.copyAction')" @click="onCopy">
      <IconCopy :size="20" stroke-width="2" />
    </button>
    <button
      type="button"
      class="message-action"
      :aria-label="t('chat.shareAction')"
      @click="onShare"
    >
      <IconShare :size="20" stroke-width="2" />
    </button>
    <button
      type="button"
      class="message-action"
      :class="{ selected: feedbackState === 'up' }"
      :aria-label="t('chat.feedback.thumbsUp')"
      @click="onThumbsUp"
    >
      <IconThumbUp :size="20" stroke-width="2" />
    </button>
    <button
      type="button"
      class="message-action"
      :class="{ selected: feedbackState === 'down' }"
      :aria-label="t('chat.feedback.thumbsDown')"
      @click="onThumbsDown"
    >
      <IconThumbDown :size="20" stroke-width="2" />
    </button>
    <button
      v-if="retryVisible"
      type="button"
      class="message-action"
      :aria-label="t('chat.actionRetry')"
      :disabled="retryDisabled"
      @click="onRetry"
    >
      <IconRefresh :size="20" stroke-width="2" />
    </button>

    <FeedbackSheet
      :open="sheetOpen"
      :submitting="feedbackInFlight"
      @submit="onSheetSubmit"
      @cancel="onSheetCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { IconCopy, IconRefresh, IconShare, IconThumbDown, IconThumbUp } from "@tabler/icons-vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useToast } from "@kit/composables"
import { useChatStore } from "@lectorium/stores/useChatStore.js"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { FeedbackCategory } from "@lib/contracts"
import FeedbackSheet from "./FeedbackSheet.vue"

const props = defineProps<{
  /** Plain-Markdown rendering of the message, already widget-stripped
   *  and verse-expanded by `messageToMarkdown`. Empty string disables
   *  both buttons — the caller is expected to hide the component in
   *  that case, but we guard defensively too. */
  markdown: string
  /** Show the Retry icon. Driven by the parent's truncated-retry
   *  visibility predicate so the action only surfaces on a truncated
   *  trailing message. */
  retryVisible?: boolean
  /** Disable the Retry icon while the store is busy (sending: true) or
   *  the bubble is no longer the last item. */
  retryDisabled?: boolean
  /** Local primary key of the assistant message. The hyphenless 32-hex
   *  form is also the Langfuse trace id for the same turn — see
   *  `chatClient.streamChat` X-Trace-Id wiring. Used both as the
   *  feedback POST identifier and as the store key for persistence. */
  messageId: ChatMessageId
  feedbackState?: "up" | "down"
}>()

const emit = defineEmits<{
  /** Forwarded up to ChatMessageBubble → ChatView → store. */
  retry: []
}>()

const { t } = useI18n()
const app = useLectorium()
const toast = useToast()
const chat = useChatStore()

const sheetOpen = ref(false)
const feedbackInFlight = ref(false)

async function onCopy(): Promise<void> {
  const md = props.markdown.trim()
  if (!md) return
  await app.shareService.copyToClipboard(md)
  void toast.info(t("chat.copyDone"))
}

async function onShare(): Promise<void> {
  const md = props.markdown.trim()
  if (!md) return
  // Share text only — no title / dialogTitle. The chat content already
  // reads like a self-contained note; an extra header just clutters
  // the recipient's preview.
  await app.shareService.share({ text: md })
}

function onRetry(): void {
  if (props.retryDisabled) return
  emit("retry")
}

async function onThumbsUp(): Promise<void> {
  if (feedbackInFlight.value) return
  feedbackInFlight.value = true
  try {
    await chat.submitFeedback(props.messageId, { state: "up" })
  } catch {
    void toast.error(t("chat.feedback.failed"))
  } finally {
    feedbackInFlight.value = false
  }
}

function onThumbsDown(): void {
  if (feedbackInFlight.value) return
  sheetOpen.value = true
}

async function onSheetSubmit(args: {
  category?: FeedbackCategory
  comment?: string
}): Promise<void> {
  feedbackInFlight.value = true
  sheetOpen.value = false
  try {
    await chat.submitFeedback(props.messageId, {
      state: "down",
      category: args.category,
      comment: args.comment,
    })
  } catch {
    void toast.error(t("chat.feedback.failed"))
  } finally {
    feedbackInFlight.value = false
  }
}

function onSheetCancel(): void {
  sheetOpen.value = false
}
</script>

<style scoped>
/* Assistant has no enclosing bubble (full-width prose, see ChatMessageBubble
 * styles); the parent `.bubble-row.assistant` is a column flex container
 * with `padding: 0 12px`, so this row inherits the gutter and just sits
 * flush against the same left edge as the prose above. */
.message-actions {
  display: flex;
  gap: 6px;
  margin: 2px 0 4px -8px;
}

.message-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ion-color-medium, #777);
  opacity: 0.5;
  cursor: pointer;
  transition: color 120ms ease;
  -webkit-tap-highlight-color: transparent;
}

.message-action:hover,
.message-action:focus-visible {
  opacity: 1;
}

.message-action:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}

/* Selected = thumb the user picked. Icon takes the primary colour;
 * no background pill, no opacity change beyond the hover-equivalent
 * full visibility. */
.message-action.selected {
  opacity: 1;
  color: var(--ion-color-primary, #3880ff);
}
</style>

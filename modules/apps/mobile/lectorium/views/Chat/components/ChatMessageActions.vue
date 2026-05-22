<template>
  <div class="message-actions">
    <button type="button" class="message-action" :aria-label="t('chat.copyAction')" @click="onCopy">
      <IconCopy :size="16" stroke-width="2" />
    </button>
    <button
      type="button"
      class="message-action"
      :aria-label="t('chat.shareAction')"
      @click="onShare"
    >
      <IconShare :size="16" stroke-width="2" />
    </button>
    <button
      v-if="retryVisible"
      type="button"
      class="message-action"
      :aria-label="t('chat.actionRetry')"
      :disabled="retryDisabled"
      @click="onRetry"
    >
      <IconRefresh :size="16" stroke-width="2" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { IconCopy, IconRefresh, IconShare } from "@tabler/icons-vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useToast } from "@lectorium/services/useToast.js"

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
}>()

const emit = defineEmits<{
  /** Forwarded up to ChatMessageBubble → ChatView → store. */
  retry: []
}>()

const { t } = useI18n()
const app = useLectorium()
const toast = useToast()

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
</script>

<style scoped>
/* Assistant has no enclosing bubble (full-width prose, see ChatMessageBubble
 * styles); the parent `.bubble-row.assistant` is a column flex container
 * with `padding: 0 12px`, so this row inherits the gutter and just sits
 * flush against the same left edge as the prose above. */
.message-actions {
  display: flex;
  gap: 4px;
  margin: 2px 0 4px -6px;
}

.message-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ion-color-medium, #777);
  opacity: 0.5;
  cursor: pointer;
  transition:
    opacity 120ms ease,
    background-color 120ms ease;
  -webkit-tap-highlight-color: transparent;
}

.message-action:hover,
.message-action:focus-visible {
  opacity: 1;
}

.message-action:active {
  opacity: 1;
  background: rgba(var(--ion-color-primary-rgb), 0.1);
}

.message-action:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}
</style>

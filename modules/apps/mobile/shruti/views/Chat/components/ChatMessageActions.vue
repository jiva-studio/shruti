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
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { IconCopy, IconShare } from "@tabler/icons-vue"
import { useShruti } from "@shruti/shruti.js"
import { useToast } from "@shruti/services/useToast.js"

const props = defineProps<{
  /** Plain-Markdown rendering of the message, already widget-stripped
   *  and verse-expanded by `messageToMarkdown`. Empty string disables
   *  both buttons — the caller is expected to hide the component in
   *  that case, but we guard defensively too. */
  markdown: string
}>()

const { t } = useI18n()
const app = useShruti()
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
</script>

<style scoped>
/* Assistant has no enclosing bubble (full-width prose, see ChatMessageBubble
 * styles), so the actions row hugs the left gutter to align with the prose
 * column rather than the page edge. */
.message-actions {
  display: flex;
  gap: 8px;
  padding: 0 12px;
  margin: -2px 0 8px;
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
</style>

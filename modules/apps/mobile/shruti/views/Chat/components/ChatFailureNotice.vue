<template>
  <InlineNotice
    :kind="noticeKind"
    :title="noticeTitle || undefined"
    :body="noticeBody"
    :cta="noticeCta"
  />
</template>

<script setup lang="ts">
/**
 * The failed-bubble notice, isolated into its own component so the whole
 * failure machinery (countdown interval, connectivity subscription, quota
 * classification, i18n + three store hookups) is created only for the rare
 * bubble that actually failed — the bubble renders this under
 * `v-if="failedKind"`. Mounting/unmounting is the gate; no extra flags.
 */
import type { ChatMessage } from "@shruti/stores/useChatStore.js"
import InlineNotice from "@ui/shared/InlineNotice.vue"
import { useChatFailureNotice } from "../composables/useChatFailureNotice.js"

const props = withDefaults(
  defineProps<{
    message: ChatMessage
    /** Whether the owning bubble is the last item in the conversation —
     *  only the trailing failure may retry (manually or on reconnect). */
    isLast?: boolean
  }>(),
  { isLast: false }
)
const emit = defineEmits<{
  retry: [messageId: string]
}>()

const { noticeKind, noticeTitle, noticeBody, noticeCta } = useChatFailureNotice({
  message: () => props.message,
  isLast: () => props.isLast,
  onRequestRetry: (id) => emit("retry", id),
})
</script>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import FloatingInput from "@lib/ui/input/FloatingInput.vue"
import ChatComposerAction from "./ChatComposerAction.vue"
import ChatUsageChip from "./ChatUsageChip.vue"

const props = defineProps<{
  sending: boolean
  /** Set while the chat rate-limit window is still open (`useChatStore.
   *  isComposeBlocked`). When true the composer disables textarea + send
   *  and swaps the placeholder for a "Limit resets at HH:MM" string —
   *  so a user who already saw the InlineNotice can't burn another 429
   *  by mashing send. */
  quotaLocked?: boolean
  /** UnixMs deadline backing `quotaLocked`. Used to format the locked-
   *  placeholder; not required to determine disabled state. */
  quotaResetsAt?: number | null
  /** Per-day chat usage snapshot from the server's SSE `usage` event
   *  (or 429 body on key_type='user'). Drives the chip above the
   *  composer when usage crosses the per-tier visibility threshold
   *  (70% free, 50% Pro). `null` keeps the chip hidden. */
  chatUsage?: { current: number; limit: number; resetsAtEpoch: number } | null
}>()
const emit = defineEmits<{ send: [text: string]; cancel: [] }>()

const { t } = useI18n()

const composerRef = ref<{
  setText: (s: string) => void
  focus: () => void
  clear: () => void
} | null>(null)

/** The field hands the text over and empties itself; the button and Enter both
 *  go through it, so there is one path out of the capsule. */
function onSubmit(textValue: string): void {
  emit("send", textValue)
}

/** Format the `{when}` fragment for the lockout copy: `"at HH:MM"` when
 *  the reset lands later today (local), `"tomorrow at HH:MM"` when it
 *  rolls past local midnight. Server's `resets_at_epoch` is next UTC
 *  midnight (~daily window), so for users east of UTC the deadline can
 *  easily fall on the local next day — bare "HH:MM" would then look
 *  like today and mislead "5:00" as "in 2 hours" when it's actually 14. */
function formatLockoutWhen(deadlineMs: number): string {
  const d = new Date(deadlineMs)
  const hh = d.getHours().toString().padStart(2, "0")
  const mm = d.getMinutes().toString().padStart(2, "0")
  const time = `${hh}:${mm}`
  const now = new Date()
  const sameLocalDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameLocalDay ? t("chat.retryAtTime", { time }) : t("chat.retryAtTimeTomorrow", { time })
}

// A single static prompt — no rotation, and no limit copy even while
// locked. When the quota is exhausted the textarea is disabled and the
// usage chip above carries the "resets {date} at {time}" detail, so the
// placeholder stays a plain, calm invitation.
const placeholder = computed<string>(() => t("chat.placeholder"))

/** Screen-reader label. The rotating placeholder ("Where did I stop?",
 *  "What is karma?", …) is decorative copy that SRs typically don't
 *  announce. When the quota lock kicks in we want VoiceOver/TalkBack to
 *  read the lock state out loud — otherwise a sighted user sees the
 *  "Limit resets at HH:MM" placeholder but a non-sighted user just
 *  hears "edit text, dimmed" with no explanation.
 *
 *  In the normal state we fall back to the generic Compose label so
 *  the textarea still has an accessible name. */
const ariaLabel = computed<string>(() => {
  if (props.quotaLocked) {
    if (typeof props.quotaResetsAt === "number") {
      return t("chat.composeLimitedAriaLabel", { when: formatLockoutWhen(props.quotaResetsAt) })
    }
    return t("chat.composeLimitedAriaLabelNoTime")
  }
  return t("chat.placeholder")
})

/** Send-button label mirrors the lock state so a SR user who tabs onto
 *  the disabled button still gets the explanation, not just "Send,
 *  dimmed". While a turn is streaming the button switches role to
 *  "Stop" so the SR user hears the actual action it triggers. */
const sendAriaLabel = computed<string>(() => {
  if (props.sending) return t("chat.stop")
  if (props.quotaLocked) {
    if (typeof props.quotaResetsAt === "number") {
      return t("chat.composeLimitedAriaLabel", { when: formatLockoutWhen(props.quotaResetsAt) })
    }
    return t("chat.composeLimitedAriaLabelNoTime")
  }
  return t("chat.send")
})

/** Programmatically fill the input — used by SuggestionChips to seed a
 *  prompt onto the empty composer. Forwarded to the shared composer,
 *  which grows + focuses the textarea so the user can tweak before
 *  sending. */
function setText(next: string): void {
  composerRef.value?.setText(next)
}

/** Focus the textarea without changing its content. Used after the
 *  "Ask Sadhu" navigation: the focus card + chips are already in place
 *  and the user expects the keyboard to come up immediately. */
function focus(): void {
  composerRef.value?.focus()
}

defineExpose({ setText, focus })
</script>

<template>
  <div class="chat-inputbar">
    <ChatUsageChip :chat-usage="chatUsage" :quota-locked="quotaLocked" />
    <FloatingInput
      ref="composerRef"
      :sending="sending"
      :disabled="quotaLocked"
      :placeholder="placeholder"
      :compose-aria-label="ariaLabel"
      @submit="onSubmit"
    >
      <template #action="{ hasText, sending: streaming, disabled, submit }">
        <ChatComposerAction
          :sending="streaming"
          :disabled="disabled"
          :has-text="hasText"
          :label="sendAriaLabel ?? placeholder"
          @send="submit()"
          @cancel="emit('cancel')"
        />
      </template>
    </FloatingInput>
  </div>
</template>

<style scoped>
.chat-inputbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* The chat sits inside IonTabs whose tab bar already absorbs the
   * device safe-area-inset-bottom — adding it here on top of that
   * pushed the capsule visibly above the tab bar. Just a small fixed
   * gap is what we want. */
  padding: 8px 12px 8px;
  background: transparent;
  pointer-events: none;
  z-index: 10;
  /* Stack the usage chip above the input capsule. column-end so when
   * the chip is absent the capsule stays flush against the bottom
   * exactly as before — no layout delta on the common path. */
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-end;
}
</style>

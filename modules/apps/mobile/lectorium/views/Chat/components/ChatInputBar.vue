<template>
  <div class="chat-inputbar">
    <ChatUsageChip :chat-usage="chatUsage" :quota-locked="quotaLocked" />
    <div class="input-capsule" :class="{ 'has-text': hasText }">
      <textarea
        ref="textareaRef"
        v-model="text"
        rows="1"
        :placeholder="placeholder"
        :aria-label="ariaLabel"
        :disabled="sending || quotaLocked"
        class="input"
        @keydown="onKeydown"
        @input="resize"
      />
      <button
        type="button"
        class="send"
        :class="{ visible: canSend || sending }"
        :aria-label="sendAriaLabel"
        :disabled="(!canSend && !sending) || quotaLocked"
        :tabindex="(canSend || sending) && !quotaLocked ? 0 : -1"
        @click="onSendClick"
      >
        <IconArrowUp v-if="!sending" :size="20" stroke="2.5" />
        <IonSpinner v-else name="dots" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import { IconArrowUp } from "@tabler/icons-vue"
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

const text = ref("")
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const hasText = computed(() => text.value.trim().length > 0)
const canSend = computed(() => !props.sending && hasText.value && !props.quotaLocked)

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

function resize(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${el.scrollHeight}px`
}

watch(text, () => {
  void nextTick(resize)
})

function onSendClick(): void {
  // While a turn is streaming the button is the Stop affordance —
  // emit `cancel` so the parent can abort the SSE stream. Quota-lock
  // still wins so users can't fire cancel during a 429 cooldown.
  if (props.sending && !props.quotaLocked) {
    emit("cancel")
    return
  }
  if (!canSend.value) return
  const payload = text.value.trim()
  text.value = ""
  emit("send", payload)
}

function onKeydown(event: KeyboardEvent): void {
  // Enter without modifiers sends; Shift+Enter / Alt+Enter insert a
  // newline. On native mobile the on-screen "Send" key triggers a plain
  // Enter, mirroring Telegram / Claude.
  if (event.key !== "Enter") return
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
  event.preventDefault()
  if (canSend.value) onSendClick()
}

/** Programmatically fill the input — used by SuggestionChips to seed a
 *  prompt onto the empty composer. Focuses + grows the textarea so the
 *  user can tweak before sending. */
function setText(next: string): void {
  text.value = next
  void nextTick(() => {
    resize()
    textareaRef.value?.focus()
    // Move caret to end so further typing appends.
    const el = textareaRef.value
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  })
}

/** Focus the textarea without changing its content. Used after the
 *  "Ask Sadhu" navigation: the focus card + chips are already in place
 *  and the user expects the keyboard to come up immediately. */
function focus(): void {
  void nextTick(() => {
    textareaRef.value?.focus()
  })
}

defineExpose({ setText, focus })
</script>

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

.input-capsule {
  position: relative;
  display: flex;
  align-items: flex-end;
  /* Palette tokens — see theme/variables.css :root +
   * @media (prefers-color-scheme: dark). Light theme lifts to white
   * above the cream page; dark theme picks a tone slightly above
   * --ion-card-background. */
  background: var(--lectorium-input-surface);
  border: 1px solid var(--lectorium-input-border);
  border-radius: 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  pointer-events: auto;
  /* Single-line geometry: capsule height matches the 36px send button
   * + 4px padding top/bottom = 44px total. With input.padding 7/7 the
   * one-line text sits flush vertical-center with the button. */
  padding: 4px 4px 4px 0;
  min-height: 44px;
  transition: padding-right 180ms cubic-bezier(0.25, 0.8, 0.25, 1);
}

.input-capsule.has-text {
  padding-right: 44px;
}

.input {
  flex: 1;
  margin: 0;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--ion-text-color);
  font: inherit;
  font-size: 15px;
  line-height: 21px;
  /* Own vertical padding (7/7) — combined with the capsule's 4/4 this
   * makes the one-line scrollHeight = 35px and total capsule height
   * = 35 + 8 ≈ 44px (clamped by min-height). The text sits flush with
   * the 36px send button. */
  padding: 7px 8px 7px 16px;
  max-height: 126px;
  overflow-y: auto;
  scrollbar-width: none;
  caret-color: var(--ion-color-primary);
}

.input::-webkit-scrollbar {
  display: none;
}

.input::placeholder {
  color: var(--ion-color-step-500, #8a8a8a);
  opacity: 1;
}

.send {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 0;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transform: scale(0.5);
  opacity: 0;
  pointer-events: none;
  transition:
    transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 140ms ease-out;
  -webkit-tap-highlight-color: transparent;
}

.send.visible {
  transform: scale(1);
  opacity: 1;
  pointer-events: auto;
}

.send:disabled {
  cursor: not-allowed;
}

.send:active:not(:disabled) {
  opacity: 0.75;
}
</style>

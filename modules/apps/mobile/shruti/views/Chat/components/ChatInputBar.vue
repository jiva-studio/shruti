<template>
  <div class="chat-inputbar">
    <!-- Per-day chat usage chip. Shows once ≥50 % of the daily allowance
         is consumed (we used to split the threshold by tier; the lower
         number for everyone gives Free users an earlier nudge and Pro
         users earlier awareness — the chip is unobtrusive enough that
         a longer visible window doesn't read as nagging). Also stays
         visible once the quota lockout kicks in: the composer placeholder
         is now a plain static prompt, so the chip is the single place
         that carries "resets {date} at {time}".
         Tap → opens the subscription page directly for non-Pro users
         (RC modal handles "already subscribed" if state goes stale).
         Pro users see the chip as a static info badge — no tap target,
         no modal, since there's nothing meaningful to open. -->
    <component
      :is="usageChipTappable ? 'button' : 'span'"
      v-if="usageChipVisible"
      :type="usageChipTappable ? 'button' : undefined"
      class="usage-chip"
      :class="{ 'is-warning': usageWarning, 'is-tappable': usageChipTappable }"
      :aria-label="usageChipLabel"
      @click="usageChipTappable ? onUsageChipTap() : null"
    >
      {{ usageChipLabel }}
    </component>
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
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"

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

const { t, locale } = useI18n()

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

// ── Usage chip ─────────────────────────────────────────────────────────
// One unified threshold for every tier — 50 % of the daily allowance.
// The earlier Free-vs-Pro split (70 / 50) over-rotated towards Pro:
// Free users were already burning past half before they saw a nudge.
// Lower bar for everyone, single percent-based label, single tap action.
// Hidden once the quota lockdown kicks in (ratio >= 1, or quotaLocked
// prop set by the parent): the composer placeholder already carries
// "Limit resets {when}" at that point — a second copy was the duplicate
// the operator flagged.
const authStore = useAuthStore()
const isPro = computed(() => authStore.isPro)

const usageRatio = computed<number | null>(() => {
  const u = props.chatUsage
  if (!u || u.limit <= 0) return null
  return Math.min(1, u.current / u.limit)
})

const usageChipVisible = computed<boolean>(() => {
  // Lockout always shows the chip: it's now the only surface carrying the
  // "resets {date} at {time}" detail (the placeholder went static). This
  // also covers the locked-but-no-snapshot case — see `usageChipLabel`.
  if (props.quotaLocked) return true
  const r = usageRatio.value
  if (r === null) return false
  return r >= 0.5
})

const usageWarning = computed<boolean>(() => (usageRatio.value ?? 0) >= 0.95)

// Tap target only matters when there's an upgrade path. Pro users get
// the same chip but as a static info badge — opening the paywall for
// someone already paying it is pointless. RC will handle a stale-tier
// case ("already subscribed") if a Free-marked client opens the paywall
// after a webhook race, so we don't need a second guard here.
const usageChipTappable = computed<boolean>(() => !isPro.value)

/** Local-TZ reset boundary as `{ date, time }`. The server's
 *  `resets_at_epoch` is next UTC midnight, so for users east of UTC it
 *  routinely lands on the local next day — showing the date (not just
 *  HH:MM) is what disambiguates it. Date is localized via Intl using the
 *  active i18n locale ("30 мая" / "30 May"). */
function localResetParts(epochS: number): { date: string; time: string } {
  const d = new Date(epochS * 1000)
  const hh = d.getHours().toString().padStart(2, "0")
  const mm = d.getMinutes().toString().padStart(2, "0")
  const date = new Intl.DateTimeFormat(locale.value, {
    day: "numeric",
    month: "long",
  }).format(d)
  return { date, time: `${hh}:${mm}` }
}

const usageChipLabel = computed<string>(() => {
  const u = props.chatUsage
  if (!u) {
    // Locked without a usage snapshot (IP-bucket 429, or a 429 body
    // lacking current/limit). The textarea is disabled but the chip is
    // the only thing on screen, so fall back to the generic lock copy
    // rather than rendering an empty pill that explains nothing.
    return props.quotaLocked ? t("chat.composeLimitedPlaceholderNoTime") : ""
  }
  const { date, time } = localResetParts(u.resetsAtEpoch)
  const p = Math.round((usageRatio.value ?? 0) * 100)
  return t("chat.usage.chip", { p, date, time })
})

function onUsageChipTap(): void {
  // Free / anonymous tap → paywall directly. No intermediate modal —
  // the subscription page already explains the offer (carousel with
  // the Pro features), so an intervening "what does this chip mean"
  // step was friction the operator pushed back on.
  usePaywallStore().requestOpen()
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
  background: var(--shruti-input-surface);
  border: 1px solid var(--shruti-input-border);
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

/* Per-day usage chip sitting just above the composer capsule. Small,
 * muted, rounded — same pill shape across tiers. Warning tone kicks
 * in at ≥95% so a near-limit user sees the urgency without us shoving
 * a banner in their face. Tappable for non-Pro (opens paywall); a
 * static info badge for Pro (`is-tappable` toggles the cursor + reset
 * default button styling that would have made the static span look
 * like a button). */
.usage-chip {
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1.2;
  padding: 4px 12px;
  margin-bottom: 4px;
  border: 1px solid var(--shruti-input-border);
  border-radius: 999px;
  background: var(--shruti-input-surface);
  color: var(--ion-color-step-650, #5c5c5c);
  pointer-events: auto;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
  -webkit-tap-highlight-color: transparent;
}

.usage-chip.is-tappable {
  cursor: pointer;
}

.usage-chip.is-warning {
  color: var(--ion-color-warning-shade, #b76e00);
  border-color: var(--ion-color-warning-tint, #ffca6b);
}

.usage-chip.is-tappable:active {
  opacity: 0.75;
}
</style>

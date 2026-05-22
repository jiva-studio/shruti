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
        <div class="error-card">
          <span class="error-text">{{ failedText }}</span>
          <button
            v-if="failedRetryAllowed"
            type="button"
            class="btn primary retry"
            :disabled="!failedRetryEnabled || !canRetry"
            @click="onRetry"
          >
            {{ failedRetryLabel }}
          </button>
        </div>
      </template>
      <template v-else>
        <StatusPill
          v-if="message.streaming && message.content.length === 0"
          :status-key="message.statusKey"
          :params="message.statusParams"
          :research-questions="message.researchQuestions"
          :research-sources="message.researchSources"
        />
        <template v-else>
          <template v-for="(token, idx) in tokens" :key="idx">
            <!--
              v-html XSS note: `token.html` is the output of marked.parseInline
              run on `message.content` inside `useMarkerParser.parseChatMarkers`.
              `marked` HTML-escapes raw text by default (it doesn't run an
              HTML sanitizer, but it never passes through arbitrary tags from
              source unless explicitly enabled). The content itself comes from
              the LLM (assistant role) — not user-typed — and the chat agent
              prompt forbids emitting raw HTML. If we ever start letting users
              author markdown that flows through this same code path, swap
              `marked.parseInline` for a DOMPurify pass first.
            -->
            <span v-if="token.kind === 'text'" v-html="token.html" />
            <CitationChip
              v-else-if="token.kind === 'cite'"
              :track-id="token.trackId"
              :start-ms="token.startMs"
              :end-ms="token.endMs"
              :caption="token.caption"
            />
            <TrackList v-else-if="token.kind === 'cards'" :track-ids="token.trackIds" />
            <OutlineCard
              v-else-if="token.kind === 'outline'"
              :track-id="token.trackId"
              :items="message.outlines?.[token.trackId]?.items ?? []"
              @pick-chapter="$emit('pick-chapter', $event)"
            />
            <ActionCardSharePdf
              v-else-if="token.kind === 'action' && token.actionKind === 'share_pdf'"
              :action-id="token.actionId"
              :payload="sharePdfPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <ActionCardEnableReminder
              v-else-if="token.kind === 'action' && token.actionKind === 'enable_daily_reminder'"
              :action-id="token.actionId"
              :payload="enableReminderPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <ActionCardConfigureSmartLibrary
              v-else-if="token.kind === 'action' && token.actionKind === 'configure_smart_library'"
              :action-id="token.actionId"
              :payload="configureSmartLibraryPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <ActionCardUpgradeToPro
              v-else-if="token.kind === 'action' && token.actionKind === 'upgrade_to_pro'"
              :action-id="token.actionId"
              :payload="upgradeToProPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <ActionCardQueueNextTrack
              v-else-if="token.kind === 'action' && token.actionKind === 'queue_next_track'"
              :action-id="token.actionId"
              :payload="queueNextTrackPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
            />
            <VerseCard
              v-else-if="token.kind === 'verse'"
              :source-id="token.sourceId"
              :tokens="token.tokens"
              :caption="token.caption"
            />
            <!--
              Markdown blockquote (library document citation). bodyHtml and
              attributionHtml are output of marked.parseInline on a vetted
              text snippet, same v-html note as for token.kind === 'text'.
            -->
            <blockquote v-else-if="token.kind === 'quote'" class="chat-quote">
              <span v-html="token.bodyHtml" />
              <span
                v-if="token.attributionHtml"
                class="chat-quote-attribution"
                v-html="token.attributionHtml"
              />
            </blockquote>
          </template>
          <span v-if="errorSuffix && !message.streaming" class="truncated-suffix">{{
            errorSuffix
          }}</span>
        </template>
      </template>
    </div>
    <ChatMessageActions
      v-if="showActions"
      :markdown="exportMarkdown"
      :retry-visible="truncatedRetryVisible"
      :retry-disabled="!canRetry"
      @retry="onRetry"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import router from "@shruti/router/index.js"
import { messageToMarkdown, parseChatMarkers } from "../composables/useMarkerParser.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useChatStore, type ActionState, type ChatMessage } from "@shruti/stores/useChatStore.js"
import { useVerseBodyStore } from "@shruti/stores/useVerseBodyStore.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import CitationChip from "./CitationChip.vue"
import ChatMessageActions from "./ChatMessageActions.vue"
import TrackList from "./TrackList.vue"
import OutlineCard from "./OutlineCard.vue"
import VerseCard from "./VerseCard.vue"
import ActionCardSharePdf from "./ActionCardSharePdf.vue"
import ActionCardEnableReminder from "./ActionCardEnableReminder.vue"
import ActionCardConfigureSmartLibrary from "./ActionCardConfigureSmartLibrary.vue"
import ActionCardUpgradeToPro from "./ActionCardUpgradeToPro.vue"
import ActionCardQueueNextTrack from "./ActionCardQueueNextTrack.vue"
import StatusPill from "./StatusPill.vue"
import ChatFocusCard from "./ChatFocusCard.vue"

const props = withDefaults(
  defineProps<{
    message: ChatMessage
    /** Whether this bubble is the last item in the conversation. Only
     *  the trailing failed/truncated message gets a Retry button —
     *  earlier ones are frozen history. */
    isLast?: boolean
    /** Persisted Ask-Sadhu chips for this focus message (lives on
     *  `meta.followups`). `null` means "fetch hasn't resolved yet" —
     *  the card falls back to the static i18n list in that case so
     *  the affordance is always visible. */
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
  /** Forwarded up from ChatFocusCard's suggestion chip taps. The
   *  parent dispatches it directly to `onSend` (focus chips are
   *  fire-and-send, no input-bar detour). */
  "send-suggestion": [text: string]
}>()
const chat = useChatStore()
const verseBody = useVerseBodyStore()
const appLanguage = useAppLanguage()
// Singleton import — see NotesView.controller for the why.
const { t } = useI18n()

const tokens = computed(() => {
  if (props.message.role !== "assistant") return []
  return parseChatMarkers(props.message.content)
})

/* -------------------------------------------------------------------- */
/*  Copy / Share — plain-Markdown rendering of the assistant message     */
/* -------------------------------------------------------------------- */

const exportMarkdown = computed<string>(() => {
  if (props.message.role !== "assistant") return ""
  if (props.message.streaming) return ""
  if (props.message.error?.kind === "failed") return ""
  const lang: "ru" | "en" = appLanguage.value.startsWith("en") ? "en" : "ru"
  return messageToMarkdown(props.message.content, {
    lang,
    verseLookup: (sourceId, tokens) => verseBody.get(sourceId, tokens),
  })
})

const showActions = computed<boolean>(
  // Retry now lives in the actions row — keep the row visible whenever
  // the truncated-retry predicate fires, even if the bubble has no
  // exportable markdown yet (edge case: empty truncated stream).
  () => exportMarkdown.value.trim().length > 0 || truncatedRetryVisible.value
)

const errorSuffix = computed(() => {
  const e = props.message.error
  if (!e) return ""
  // Pattern-match on discriminator. Unknown kinds fall through to "" so
  // older clients reading newer rows don't render a confusing label.
  if (e.kind === "truncated") {
    return e.reason === "turns" ? t("chat.errTruncatedTurns") : t("chat.errTruncatedStream")
  }
  return ""
})

/* -------------------------------------------------------------------- */
/*  Failure rendering: dedicated bubble for `failed` + retry button     */
/* -------------------------------------------------------------------- */

/** Tick once per second while a `rate_limited` countdown is on the
 *  screen. Used to recompute `failedText` (counts down "in N s") and
 *  `failedRetryEnabled` (flips at the deadline). */
const now = ref(Date.now())
let tickHandle: ReturnType<typeof setInterval> | null = null

function stopTick(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle)
    tickHandle = null
  }
}

// Drive the tick off `error.retryAfterAt`. Watching (not onMounted) so
// a bubble that transitions from streaming → failed AFTER mount — e.g.
// the in-flight placeholder converted to a `rate_limited` failure by
// `applyTurnEvent('error')` in the store — still gets a live countdown.
watch(
  () => {
    const e = props.message.error
    return e?.kind === "failed" && typeof e.retryAfterAt === "number" ? e.retryAfterAt : null
  },
  (retryAfterAt) => {
    stopTick()
    if (retryAfterAt === null) return
    now.value = Date.now()
    tickHandle = setInterval(() => {
      now.value = Date.now()
      // Stop ticking once the deadline passes — the button becomes
      // enabled and the wording stops referring to time.
      if (now.value >= retryAfterAt) stopTick()
    }, 1000)
  },
  { immediate: true }
)

onBeforeUnmount(stopTick)

const failedKind = computed<boolean>(() => {
  const e = props.message.error
  return !!(e && e.kind === "failed" && !props.message.streaming)
})

/** Codes where Retry would not help (auth needs restart, protocol
 *  mismatch needs an update). We still show the message — just no
 *  button under it. */
const failedRetryAllowed = computed<boolean>(() => {
  const e = props.message.error
  if (!e || e.kind !== "failed") return false
  return e.code !== "http_401" && e.code !== "http_403" && e.code !== "protocol_version_required"
})

const failedRetryEnabled = computed<boolean>(() => {
  const e = props.message.error
  if (!e || e.kind !== "failed") return false
  if (typeof e.retryAfterAt === "number") return now.value >= e.retryAfterAt
  return true
})

const truncatedRetryVisible = computed<boolean>(() => {
  const e = props.message.error
  return !!(e && e.kind === "truncated" && !props.message.streaming && props.isLast)
})

/** True iff the store is idle and this bubble is the last one. Earlier
 *  failed bubbles in scrolled-back history stay decorative. */
const canRetry = computed<boolean>(() => props.isLast && !chat.sending)

const failedText = computed<string>(() => {
  const e = props.message.error
  if (!e || e.kind !== "failed") return ""
  if (e.code === "rate_limited") {
    if (typeof e.retryAfterAt === "number") {
      const remainingMs = e.retryAfterAt - now.value
      if (remainingMs > 0) {
        return t("chat.errRateAfter", { when: formatRetryWhen(remainingMs, e.retryAfterAt) })
      }
    }
    return t("chat.errRate")
  }
  if (e.code === "max_turns_exceeded") return t("chat.errMaxTurns")
  if (e.code === "agent_error") return t("chat.errAgent")
  if (e.code === "http_401" || e.code === "http_403") return t("chat.errAuth")
  if (e.code === "protocol_version_required") return t("chat.errProtocol")
  if (e.code.startsWith("http_5")) return t("chat.errServiceNotReady")
  if (e.code === "network") return t("chat.errNetwork")
  if (e.code === "stream") return t("chat.errStreamDropped")
  return t("chat.errUnknown")
})

const failedRetryLabel = computed<string>(() => t("chat.actionRetry"))

/**
 * Format a "{when}" fragment for `errRateAfter`:
 *  - <  60s → "in N s" (countdown, ticks every second)
 *  - <  1h  → "in N min" (still ticks but in coarser units)
 *  - else   → "at HH:MM" (no countdown; would be visually noisy at hours)
 *
 * Server's `Retry-After` for our /chat endpoint is seconds-until-midnight-UTC
 * (see backend rate_limiter.py), which can easily land in the hours range
 * when the user blows through quota early in the day.
 */
function formatRetryWhen(remainingMs: number, deadlineMs: number): string {
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds < 60) return t("chat.retryInSeconds", { n: seconds })
  if (seconds < 60 * 60) {
    const minutes = Math.ceil(seconds / 60)
    return t("chat.retryInMinutes", { n: minutes })
  }
  const d = new Date(deadlineMs)
  const hh = d.getHours().toString().padStart(2, "0")
  const mm = d.getMinutes().toString().padStart(2, "0")
  return t("chat.retryAtTime", { time: `${hh}:${mm}` })
}

function onRetry(): void {
  if (!canRetry.value) return
  emit("retry", props.message.id)
}

function actionState(actionId: string): ActionState {
  const raw = props.message.actionStates?.[actionId]
  // Only surface the four states the UI actually renders. Anything else
  // (legacy "dismissed" from earlier sessions, missing key, garbage)
  // collapses to "pending" so the Create button is always reachable.
  if (raw === "executing" || raw === "done" || raw === "error") return raw
  return "pending"
}

function sharePdfPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "share_pdf" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "share_pdf" ? a : undefined
}

function enableReminderPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "enable_daily_reminder" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "enable_daily_reminder" ? a : undefined
}

function configureSmartLibraryPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "configure_smart_library" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "configure_smart_library" ? a : undefined
}

function upgradeToProPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "upgrade_to_pro" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "upgrade_to_pro" ? a : undefined
}

function queueNextTrackPayload(
  actionId: string
): Extract<ChatActionPayload, { kind: "queue_next_track" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "queue_next_track" ? a : undefined
}

async function onConfirmAction(actionId: string, override?: { time?: string }): Promise<void> {
  // Snapshot the kind BEFORE executeAction — the store may mutate
  // actionStates and the action payload reference can disappear from
  // an aborted/replaced message later.
  const kind = props.message.actions?.[actionId]?.kind
  await chat.executeAction(props.message.id, actionId, override)
  // Smart Library: the chat-side handler set the auto-download filters
  // we received, but the user has no UI feedback in the chat surface.
  // Land them on the Settings tab where the Smart Library section
  // reflects whatever was just applied (empty payload from the LLM →
  // they see the regular Settings card and can configure manually).
  if (kind === "configure_smart_library") {
    void router.push("/tabs/settings")
  }
}
</script>

<style scoped>
/* Library document citation — styled blockquote rendered between text
 * tokens. Body inherits inline-md spans (em/strong/code); attribution
 * sits on a separate line, smaller and italic.
 */
.chat-quote {
  display: block;
  margin: 8px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--ion-color-primary, #5a3e8e);
  background: rgba(90, 62, 142, 0.06);
  border-radius: 4px;
  font-style: italic;
  color: var(--ion-color-medium-shade, #4d4d4d);
  line-height: 1.4;
}
.chat-quote-attribution {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  font-style: italic;
  color: var(--ion-color-medium, #777);
}

.bubble-row {
  display: flex;
  margin: 6px 0;
  padding: 0 12px;
  /* `scrollIntoView({ block: "start" })` aligns the row's top edge with
   * viewport y = scroll-margin-top (IonContent is fullscreen so the
   * scroll-port top sits at viewport y=0). Land the row right below
   * the 52px action row: safe-area + 4 (top pad) + 44 (buttons) + 4
   * (bottom pad). The fade gradient extends another 28px past this,
   * softly masking the bubble's top edge — that's the designed look
   * (content "emerges" from under the header) rather than parking the
   * bubble below the fade with visible empty space. */
  scroll-margin-top: calc(var(--ion-safe-area-top, 0px) + 56px);
}

.bubble-row.user {
  justify-content: flex-end;
}

.bubble-row.assistant {
  /* Stack the assistant's full-width prose on top of the inline action
   * row (`ChatMessageActions`). A flex-row layout would shove the
   * actions next to the bubble, and since `.bubble.assistant` is
   * width: 100%, the actions would steal space from the text and end
   * up parked at the top-right of the first paragraph instead of
   * under the whole message. */
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
 * full-width prose (Claude pattern). Keeps the page wider for reading
 * long replies, cards, and citation chips without an enclosing pill. */
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

.thinking {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 4px 0;
}

.thinking .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ion-color-step-500, #9a9a9a);
  animation: thinking-pulse 1.2s ease-in-out infinite;
}

.thinking .dot:nth-child(2) {
  animation-delay: 0.15s;
}

.thinking .dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes thinking-pulse {
  0%,
  60%,
  100% {
    opacity: 0.4;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

/* Inline markdown styles (marked.parseInline output): keep them
 * scoped-safe by allowing :deep into the v-html span tree. */
.bubble.assistant :deep(strong) {
  font-weight: 600;
}

.bubble.assistant :deep(em) {
  font-style: italic;
}

.bubble.assistant :deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}

.bubble.assistant :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}

/* Trailing "(прервано)" / "(cut off)" suffix on a message that ended
 * without a clean `done`. Inline, lower-key colour, so it reads as a
 * note rather than competing with the bubble text. */
.bubble.assistant .truncated-suffix {
  color: var(--ion-color-medium);
  font-style: italic;
  font-size: 0.85em;
  white-space: pre;
}

/* Failed-bubble: replaces the assistant content when the turn died with
 * no streamed text. Block-level so the Retry button can sit on its own
 * line under the explanation. Matches the action-card error styling
 * (rounded danger-tinted block + flat primary button) so the user
 * recognises it as an inline status, not a stray paragraph. */
.bubble.assistant .error-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(var(--ion-color-danger-rgb, 235, 68, 90), 0.32);
  background: rgba(var(--ion-color-danger-rgb, 235, 68, 90), 0.08);
}

.bubble.assistant .error-card .error-text {
  color: var(--ion-color-danger, #eb445a);
  font-size: 0.92em;
  line-height: 1.35;
}

.bubble.assistant .btn.primary.retry {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  border: 0;
  border-radius: 10px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.bubble.assistant .btn.primary.retry:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>

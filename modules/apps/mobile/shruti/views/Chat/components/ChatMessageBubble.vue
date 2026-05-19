<template>
  <div
    :class="[
      'bubble-row',
      message.role,
      { 'streaming-placeholder': message.role === 'assistant' && message.streaming },
    ]"
    :data-message-id="message.id"
  >
    <div :class="['bubble', message.role, { streaming: message.streaming }]">
      <template v-if="message.role === 'user'">
        <span class="user-text">{{ message.content }}</span>
      </template>
      <template v-else>
        <span v-if="message.content.length === 0 && message.streaming" class="thinking">
          <span class="dot" />
          <span class="dot" />
          <span class="dot" />
        </span>
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
            <LectureCard v-else-if="token.kind === 'card'" :track-id="token.trackId" />
            <OutlineCard
              v-else-if="token.kind === 'outline'"
              :track-id="token.trackId"
              :items="message.outlines?.[token.trackId]?.items ?? []"
              @pick-chapter="$emit('pick-chapter', $event)"
            />
            <ActionCardPlaylist
              v-else-if="token.kind === 'action' && token.actionKind === 'create_playlist'"
              :action-id="token.actionId"
              :payload="playlistPayload(token.actionId)"
              :state="actionState(token.actionId)"
              @confirm="onConfirmAction"
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
          </template>
          <span v-if="errorSuffix && !message.streaming" class="truncated-suffix">{{
            errorSuffix
          }}</span>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import router from "@shruti/router/index.js"
import { parseChatMarkers } from "../composables/useMarkerParser.js"
import { useChatStore, type ActionState, type ChatMessage } from "@shruti/stores/useChatStore.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionPayload } from "@shruti/services/chatClient.js"
import CitationChip from "./CitationChip.vue"
import LectureCard from "./LectureCard.vue"
import OutlineCard from "./OutlineCard.vue"
import ActionCardPlaylist from "./ActionCardPlaylist.vue"
import ActionCardSharePdf from "./ActionCardSharePdf.vue"
import ActionCardEnableReminder from "./ActionCardEnableReminder.vue"
import ActionCardConfigureSmartLibrary from "./ActionCardConfigureSmartLibrary.vue"
import ActionCardUpgradeToPro from "./ActionCardUpgradeToPro.vue"
import ActionCardQueueNextTrack from "./ActionCardQueueNextTrack.vue"

const props = defineProps<{ message: ChatMessage }>()
defineEmits<{
  /** Forwarded from the inline OutlineCard. The view-level controller
   *  owns prompt assembly + chat.sendMessage. */
  "pick-chapter": [
    args: {
      trackId: string
      item: { startMs: number; title: string }
      nextItem: { startMs: number; title: string } | null
    },
  ]
}>()
const chat = useChatStore()
// Singleton import — see NotesView.controller for the why.
const { t } = useI18n()

const tokens = computed(() => {
  if (props.message.role !== "assistant") return []
  return parseChatMarkers(props.message.content)
})

const errorSuffix = computed(() => {
  const e = props.message.error
  if (!e) return ""
  // Pattern-match on discriminator. Unknown kinds fall through to "" so
  // older clients reading newer rows don't render a confusing label.
  // UI doesn't expose a retry button yet — that needs Last-Event-ID
  // resume on the SSE channel.
  if (e.kind === "truncated") {
    return e.reason === "turns" ? t("chat.errTruncatedTurns") : t("chat.errTruncatedStream")
  }
  return ""
})

function actionState(actionId: string): ActionState {
  const raw = props.message.actionStates?.[actionId]
  // Only surface the four states the UI actually renders. Anything else
  // (legacy "dismissed" from earlier sessions, missing key, garbage)
  // collapses to "pending" so the Create button is always reachable.
  if (raw === "executing" || raw === "done" || raw === "error") return raw
  return "pending"
}

function playlistPayload(
  actionId: string
): Extract<ActionPayload, { kind: "create_playlist" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "create_playlist" ? a : undefined
}

function sharePdfPayload(
  actionId: string
): Extract<ActionPayload, { kind: "share_pdf" }> | undefined {
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
.bubble-row {
  display: flex;
  margin: 6px 0;
  padding: 0 12px;
}

.bubble-row.user {
  justify-content: flex-end;
}

.bubble-row.assistant {
  justify-content: flex-start;
}

/* While the assistant placeholder is streaming, reserve enough vertical
 * room below the user's just-sent message that the controller's
 * `scrollMessageToTop` can actually move it to the top of the viewport.
 * Without this the placeholder is only ~50px tall (just the thinking
 * dots) and there's nothing to scroll into, so the user message stays
 * pinned to the bottom of the visible area.
 *
 * `svh` (small viewport height) matches the layout the keyboard leaves
 * us with on mobile — the keyboard doesn't push this bubble off-screen.
 * The 200px deduction accounts for the fixed-top fade (~56px), the
 * input bar (~64px) and ~80px safety margin for OS gestures and the
 * just-sent user bubble.
 *
 * Once the turn is finalised, the store swaps the streaming placeholder
 * out for the real message (`m.streaming` becomes undefined), the class
 * binding drops, and the rule disappears — no permanent empty space
 * below the conversation. */
.bubble-row.streaming-placeholder {
  min-height: calc(100svh - 200px);
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
</style>

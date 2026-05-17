<template>
  <div :class="['bubble-row', message.role]">
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
            <ActionCardNote
              v-else-if="token.kind === 'action' && token.actionKind === 'save_note'"
              :action-id="token.actionId"
              :payload="notePayload(token.actionId)"
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
import { parseChatMarkers } from "../composables/useMarkerParser.js"
import { useChatStore, type ActionState, type ChatMessage } from "@shruti/stores/useChatStore.js"
import type { ActionPayload } from "@shruti/services/chatClient.js"
import CitationChip from "./CitationChip.vue"
import LectureCard from "./LectureCard.vue"
import OutlineCard from "./OutlineCard.vue"
import ActionCardPlaylist from "./ActionCardPlaylist.vue"
import ActionCardNote from "./ActionCardNote.vue"

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
  // No salvage here — useChatStore.sendMessage's finalisation already
  // rebuilt orphan create_playlist actions from sibling [card:...]
  // markers before persisting. The bubble is presentation-only.
  return a && a.kind === "create_playlist" ? a : undefined
}

function notePayload(actionId: string): Extract<ActionPayload, { kind: "save_note" }> | undefined {
  const a = props.message.actions?.[actionId]
  return a && a.kind === "save_note" ? a : undefined
}

async function onConfirmAction(actionId: string): Promise<void> {
  await chat.executeAction(props.message.id, actionId)
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

<template>
  <template v-for="(token, idx) in tokens" :key="idx">
    <!--
      v-html XSS note: `token.html` is the output of marked.parseInline
      run on `message.content` inside `chatMarkers.parseChatMarkers`.
      `marked` HTML-escapes raw text by default. The content comes from
      the LLM (assistant role) — not user-typed — and the chat agent
      prompt forbids emitting raw HTML. If we ever let users author
      markdown through this path, swap in a DOMPurify pass first.
    -->
    <span v-if="token.kind === 'text'" v-html="token.html" />
    <CitationCard
      v-else-if="token.kind === 'cite'"
      :track-id="token.trackId"
      :start-ms="token.startMs"
      :end-ms="token.endMs"
      :caption="token.caption"
      :body="message.cites?.[`${token.trackId}|${token.startMs}-${token.endMs}`]"
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
      :body="message.verses?.[`${token.sourceId}|${token.tokens}`]"
    />
    <ChapterCard
      v-else-if="token.kind === 'chapter'"
      :source-id="token.sourceId"
      :region-token="token.regionToken"
      :caption="token.caption"
      :body="message.chapters?.[`${token.sourceId}|${token.regionToken}`]"
    />
    <MediaCard v-else-if="token.kind === 'media'" :payload="message.media?.[token.mediaId]" />
    <CommentaryCard
      v-else-if="token.kind === 'commentary'"
      :body="message.commentaries?.[String(token.ref)]"
    />
    <!--
      Markdown blockquote (library document citation). bodyHtml and
      attributionHtml are output of marked.parseInline on a vetted text
      snippet, same v-html note as for token.kind === 'text'.
    -->
    <AccentFrame v-else-if="token.kind === 'quote'" class="chat-quote">
      <div class="chat-quote-body">
        <span v-html="token.bodyHtml" />
        <span
          v-if="token.attributionHtml"
          class="chat-quote-attribution"
          v-html="token.attributionHtml"
        />
      </div>
    </AccentFrame>
  </template>
</template>

<script setup lang="ts">
import { computed } from "vue"
import router from "@shruti/router/index.js"
import { parseChatMarkers } from "@shruti/composables/chatMarkers.js"
import { useChatStore, type ActionState, type ChatMessage } from "@shruti/stores/useChatStore.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import AccentFrame from "./AccentFrame.vue"
import CitationCard from "./CitationCard.vue"
import TrackList from "./TrackList.vue"
import OutlineCard from "./OutlineCard.vue"
import VerseCard from "./VerseCard.vue"
import ChapterCard from "./ChapterCard.vue"
import MediaCard from "./MediaCard.vue"
import CommentaryCard from "./CommentaryCard.vue"
import ActionCardSharePdf from "./ActionCardSharePdf.vue"
import ActionCardEnableReminder from "./ActionCardEnableReminder.vue"
import ActionCardConfigureSmartLibrary from "./ActionCardConfigureSmartLibrary.vue"
import ActionCardUpgradeToPro from "./ActionCardUpgradeToPro.vue"
import ActionCardQueueNextTrack from "./ActionCardQueueNextTrack.vue"

const props = defineProps<{ message: ChatMessage }>()
defineEmits<{
  "pick-chapter": [
    args: {
      trackId: string
      item: { startMs: number; title: string }
      nextItem: { startMs: number; title: string } | null
    },
  ]
}>()

const chat = useChatStore()

const tokens = computed(() => {
  if (props.message.role !== "assistant") return []
  return parseChatMarkers(props.message.content)
})

function actionState(actionId: string): ActionState {
  const raw = props.message.actionStates?.[actionId]
  // Only surface the four states the UI renders; anything else collapses
  // to "pending" so the Create button is always reachable.
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
  // actionStates and the action payload reference can disappear later.
  const kind = props.message.actions?.[actionId]?.kind
  await chat.executeAction(props.message.id, actionId, override)
  // Smart Library: land the user on Settings where the section reflects
  // whatever was just applied (the chat surface has no other feedback).
  if (kind === "configure_smart_library") {
    void router.push("/tabs/settings")
  }
}
</script>

<style scoped>
/* Library document citation — styled blockquote rendered between text
 * tokens. */
.chat-quote {
  margin: 8px 0;
  color: inherit;
  line-height: 1.4;
}
.chat-quote-body {
  padding: 6px 12px;
}
.chat-quote-attribution {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  font-style: italic;
  color: var(--ion-color-medium, #777);
}

/* Inline markdown styles (marked.parseInline output) — allow :deep into
 * the v-html span tree. */
:deep(strong) {
  font-weight: 600;
}
:deep(em) {
  font-style: italic;
}
:deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}
:deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}

/* Section header (`## Label`): centered label with a fading gradient
 * rule on each side. */
:deep(h2.chat-header) {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 8px;
  font-weight: 700;
  font-size: 14px;
  color: var(--ion-color-primary);
  text-align: center;
}
:deep(h2.chat-header)::before,
:deep(h2.chat-header)::after {
  content: "";
  flex: 1;
  min-width: 16px;
  height: 1px;
  background-image: linear-gradient(
    to right,
    transparent,
    rgba(var(--ion-color-tertiary-rgb), 0.3)
  );
}
:deep(h2.chat-header)::after {
  background-image: linear-gradient(to left, transparent, rgba(var(--ion-color-tertiary-rgb), 0.3));
}
</style>

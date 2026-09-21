<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IconChevronDown, IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { parseChatMarkers } from "@lib/chat/chatMarkers.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { type ChatMessage } from "@lectorium/stores/useChatStore.js"
import type { CitationCoords } from "../composables/useCitationMeta.js"
import CitationCardContainer from "./CitationCardContainer.vue"
import CitationActionSheet from "./CitationActionSheet.vue"
import TrackList from "./TrackList.vue"
import OutlineCardContainer from "./OutlineCardContainer.vue"
import VerseCardContainer from "./VerseCardContainer.vue"
import ChapterCard from "@lib/ui/chat/ChapterCard.vue"
import MediaCardContainer from "./MediaCardContainer.vue"
import CommentaryCardContainer from "./CommentaryCardContainer.vue"
import WeeklyDigestCard from "./WeeklyDigestCard.vue"
import ChatActionToken from "./ChatActionToken.vue"
import ChatQuoteToken from "./ChatQuoteToken.vue"

const props = defineProps<{
  message: ChatMessage
  /** Mirrors `useChatStore.isComposeBlocked`. Only the outline card acts on
   *  it: its chapter rows dispatch a turn, which the store refuses while the
   *  quota lock is armed. Every other token here reads or navigates. */
  quotaLocked?: boolean
}>()
defineEmits<{
  "pick-chapter": [
    args: {
      trackId: string
      item: { startMs: number; title: string }
      nextItem: { startMs: number; title: string } | null
    },
  ]
}>()

const app = useLectorium()
const { locale } = useI18n()

// MediaCard turns a relative storage path into the active server's CDN URL.
const storagePublicUrlGet = (path: string): string => app.storagePublicUrl.get(path)

const tokens = computed(() => {
  if (props.message.role !== "assistant") return []
  return parseChatMarkers(props.message.content)
})

// One sheet for every citation card in the message: a card emits `activate`,
// and the sheet is pointed at that fragment.
const citeSheetOpen = ref(false)
const activeCite = ref<CitationCoords | null>(null)
const activeCiteSnippet = ref<string | null>(null)

function onActivateCite(token: {
  trackId: string
  startMs: number
  endMs: number
  caption?: string
}): void {
  activeCite.value = {
    trackId: token.trackId,
    startMs: token.startMs,
    endMs: token.endMs,
    caption: token.caption,
  }
  activeCiteSnippet.value =
    props.message.cites?.[`${token.trackId}|${token.startMs}-${token.endMs}`]?.text ?? null
  citeSheetOpen.value = true
}
</script>

<template>
  <template v-for="(token, idx) in tokens" :key="idx">
    <!--
      v-html: `token.html` comes from `inlineMarkdownToHtml`, which escapes
      the source before it parses — `marked` does not, and this text is the
      model's. Anything rendered here must go through that same path.
    -->
    <span v-if="token.kind === 'text'" v-html="token.html" />
    <CitationCardContainer
      v-else-if="token.kind === 'cite'"
      :track-id="token.trackId"
      :start-ms="token.startMs"
      :end-ms="token.endMs"
      :caption="token.caption"
      :body="message.cites?.[`${token.trackId}|${token.startMs}-${token.endMs}`]"
      @activate="onActivateCite(token)"
    />
    <TrackList v-else-if="token.kind === 'cards'" :track-ids="token.trackIds" />
    <OutlineCardContainer
      v-else-if="token.kind === 'outline'"
      :track-id="token.trackId"
      :items="message.outlines?.[token.trackId]?.items ?? []"
      :disabled="quotaLocked"
      @pick-chapter="$emit('pick-chapter', $event)"
    />
    <ChatActionToken
      v-else-if="token.kind === 'action'"
      :message="message"
      :action-id="token.actionId"
      :action-kind="token.actionKind"
    />
    <VerseCardContainer
      v-else-if="token.kind === 'verse'"
      :source-id="token.sourceId"
      :tokens="token.tokens"
      :caption="token.caption"
      :body="message.verses?.[`${token.sourceId}|${token.tokens}`]"
      :locale="locale"
    />
    <ChapterCard
      v-else-if="token.kind === 'chapter'"
      :source-id="token.sourceId"
      :region-token="token.regionToken"
      :caption="token.caption"
      :body="message.chapters?.[`${token.sourceId}|${token.regionToken}`]"
    />
    <MediaCardContainer
      v-else-if="token.kind === 'media'"
      :payload="message.media?.[token.mediaId]"
      :resolve-url="storagePublicUrlGet"
    >
      <template #play-icon="{ size }"><IconPlayerPlayFilled :size="size" /></template>
      <template #pause-icon="{ size }"><IconPlayerPauseFilled :size="size" /></template>
      <template #expand-icon="{ size }"><IconChevronDown :size="size" /></template>
    </MediaCardContainer>
    <CommentaryCardContainer
      v-else-if="token.kind === 'commentary'"
      :body="message.commentaries?.[String(token.ref)]"
    />
    <WeeklyDigestCard
      v-else-if="token.kind === 'digest'"
      :from-ms="token.fromMs"
      :to-ms="token.toMs"
    />
    <ChatQuoteToken
      v-else-if="token.kind === 'quote'"
      :body-html="token.bodyHtml"
      :attribution-html="token.attributionHtml"
    />
  </template>

  <!-- The sheet lives here, not in the card, so the card stays a leaf. -->
  <CitationActionSheet
    v-model:open="citeSheetOpen"
    :coords="activeCite"
    :snippet-text="activeCiteSnippet"
  />
</template>

<style scoped>
/* Inline markdown (marked.parseInline output) — :deep reaches into the
 * v-html span tree. */
:deep(strong) {
  font-weight: 600;
}
:deep(em) {
  font-style: italic;
}
:deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}
:deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}

/* Section header (`## Label`): a centred label with a fading rule each side. */
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

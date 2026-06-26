<script setup lang="ts">
import { computed } from 'vue'
// REAL reused app code (single source of truth):
import { parseChatMarkers, type ChatToken } from '@lib/chat/chatMarkers/parse.js'
import ChapterCard from '@lib/ui/chat/ChapterCard.vue'
import OutlineCard from '@lib/ui/chat/OutlineCard.vue'
import WebVerseCard from './WebVerseCard.vue'
import WebCitationCard from './WebCitationCard.vue'
import WebTrackCard from './WebTrackCard.vue'
import WebCommentaryCard from './WebCommentaryCard.vue'
import WebMediaCard from './WebMediaCard.vue'
import { STORE } from '../../i18n/ui'
import { MEDIA_BASE } from '../../lib/media'
import type {
  CardPayload,
  ChapterPayload,
  CitationPayload,
  CommentaryPayload,
  OutlinePayload,
  PdfActionPayload,
  PdfItemPayload,
  VersePayload,
} from './types/chat'
import type { MediaPayload } from './types/media'

const props = defineProps<{
  text: string
  lang: 'ru' | 'en'
  verses?: Map<string, VersePayload>
  chapters?: Map<string, ChapterPayload>
  cites?: Map<string, CitationPayload>
  cards?: Map<string, CardPayload>
  commentaries?: Map<string, CommentaryPayload>
  media?: Map<string, MediaPayload>
  outlines?: Map<string, OutlinePayload>
  pdfActions?: Map<string, PdfActionPayload>
}>()

const tokens = computed<ChatToken[]>(() => parseChatMarkers(props.text))

const outlineLabel = computed(() => (props.lang === 'ru' ? 'Оглавление' : 'Outline'))

type VerseToken = Extract<ChatToken, { kind: 'verse' }>
type ChapterToken = Extract<ChatToken, { kind: 'chapter' }>
type CiteToken = Extract<ChatToken, { kind: 'cite' }>
type CommentaryToken = Extract<ChatToken, { kind: 'commentary' }>
type MediaToken = Extract<ChatToken, { kind: 'media' }>
type CardsToken = Extract<ChatToken, { kind: 'cards' }>
type OutlineToken = Extract<ChatToken, { kind: 'outline' }>
type ActionToken = Extract<ChatToken, { kind: 'action' }>

function verseBody(t: VerseToken) {
  return props.verses?.get(`${t.sourceId}|${t.tokens}`)
}
function chapterBody(t: ChapterToken) {
  return props.chapters?.get(`${t.sourceId}|${t.regionToken}`)
}
function citeBody(t: CiteToken) {
  return props.cites?.get(`${t.trackId}|${t.startMs}-${t.endMs}`)
}
function commentaryBody(t: CommentaryToken) {
  return props.commentaries?.get(String(t.ref))
}
function mediaBody(t: MediaToken) {
  return props.media?.get(t.mediaId)
}
function outlineBody(t: OutlineToken) {
  return props.outlines?.get(t.trackId)
}
function cardBody(trackId: string) {
  return props.cards?.get(trackId)
}
function pdfBody(t: ActionToken) {
  return props.pdfActions?.get(t.actionId)
}

function pdfItems(t: ActionToken): PdfItemPayload[] {
  const body = pdfBody(t)
  return Array.isArray(body?.items) ? body.items : []
}
function pdfTrackId(it: PdfItemPayload): string {
  return it.track_id ?? it.trackId ?? ''
}
function pdfTitle(it: PdfItemPayload): string {
  return it.title || pdfTrackId(it)
}
function pdfUrl(it: PdfItemPayload): string {
  const trackId = pdfTrackId(it)
  const lang = it.lang || props.lang || 'ru'
  return `${MEDIA_BASE}/public/tracks/${trackId}/exports/${lang}.pdf`
}

const pdfLabel = computed(() => (props.lang === 'ru' ? 'Скачать PDF' : 'Download PDF'))
const getAppLabel = computed(() =>
  props.lang === 'ru' ? 'Открыть в приложении' : 'Open in the app'
)
</script>

<template>
  <div class="chat-prose">
    <template v-for="(tk, i) in tokens" :key="i">
      <span v-if="tk.kind === 'text'" class="prose-text" v-html="tk.html" />
      <blockquote
        v-else-if="tk.kind === 'quote'"
        class="my-2 border-l-2 border-saffron/50 pl-3 italic text-ink/90"
      >
        <span v-html="tk.bodyHtml" />
        <span v-if="tk.attributionHtml" class="mt-1 block text-sm not-italic text-medium" v-html="tk.attributionHtml" />
      </blockquote>

      <!-- VERSE: real VerseCard when the payload streamed, else a chip -->
      <WebVerseCard
        v-else-if="tk.kind === 'verse'"
        :source-id="tk.sourceId"
        :tokens="tk.tokens"
        :caption="tk.caption"
        :body="verseBody(tk)"
        :locale="lang"
      />

      <!-- CHAPTER: real ChapterCard when the payload streamed, else a chip -->
      <ChapterCard
        v-else-if="tk.kind === 'chapter'"
        :source-id="tk.sourceId"
        :region-token="tk.regionToken"
        :caption="tk.caption"
        :body="chapterBody(tk)"
      />

      <!-- CITE: real CitationCard with the transcript snippet, else a chip.
           #player is the WebExcerptPlayer with web cut/predict adapters. -->
      <WebCitationCard
        v-else-if="tk.kind === 'cite'"
        :track-id="tk.trackId"
        :start-ms="tk.startMs"
        :end-ms="tk.endMs"
        :body="citeBody(tk)"
        :caption="tk.caption"
        :language="lang"
      />

      <!-- CARDS: whole-lecture tiles (find_track results). Rendered from the
           server-sent `card` attribution — web has no local catalog. -->
      <template v-else-if="tk.kind === 'cards'">
        <WebTrackCard
          v-for="tid in tk.trackIds"
          :key="tid"
          :track-id="tid"
          :body="cardBody(tid)"
          :language="lang"
        />
      </template>

      <!-- COMMENTARY: real CommentaryCard. Absent body → nothing. -->
      <WebCommentaryCard
        v-else-if="tk.kind === 'commentary'"
        :body="commentaryBody(tk)"
      />

      <!-- MEDIA: real MediaCard; WebMediaCard resolves the relative
           bucket path (`public/media/<id>.mp4`) against the CDN base. -->
      <WebMediaCard
        v-else-if="tk.kind === 'media'"
        :payload="mediaBody(tk)"
      />

      <!-- OUTLINE: real OutlineCard when the payload streamed, else a chip. -->
      <template v-else-if="tk.kind === 'outline'">
        <OutlineCard
          v-if="outlineBody(tk)"
          :track-id="tk.trackId"
          :items="outlineBody(tk).items"
          :track-title="outlineBody(tk).trackTitle"
          @open-lecture="() => {}"
        >
          <template #more="{ n }">+{{ n }}</template>
        </OutlineCard>
        <span v-else class="cite-chip">{{ outlineLabel }}</span>
      </template>

      <!-- SHARE_PDF action: list each lecture with a Download PDF link plus a
           store CTA. -->
      <div
        v-else-if="tk.kind === 'action' && tk.actionKind === 'share_pdf' && pdfItems(tk).length"
        class="pdf-card"
      >
        <ul class="pdf-list">
          <li v-for="(it, j) in pdfItems(tk)" :key="pdfTrackId(it) + '-' + j" class="pdf-row">
            <span class="pdf-title">{{ pdfTitle(it) }}</span>
            <a class="pdf-dl" :href="pdfUrl(it)" target="_blank" rel="noopener">{{ pdfLabel }}</a>
          </li>
        </ul>
        <a class="pdf-cta" :href="STORE.appStore" target="_blank" rel="noopener">{{ getAppLabel }}</a>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-prose {
  line-height: 1.6;
}
/* pre-wrap only on the streamed text, so the reused card components keep
   their own normal whitespace (no reaching into them). */
.prose-text {
  white-space: pre-wrap;
}
.prose-text :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: underline;
}
.prose-text :deep(strong) {
  font-weight: 600;
}
.prose-text :deep(em) {
  font-style: italic;
}
.prose-text :deep(code) {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: rgba(var(--ion-color-medium-rgb), 0.12);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 0.9em;
}
.prose-text :deep(h2.chat-header) {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 8px;
  font-weight: 700;
  font-size: 14px;
  color: var(--ion-color-primary);
  text-align: center;
}
.prose-text :deep(h2.chat-header)::before,
.prose-text :deep(h2.chat-header)::after {
  content: '';
  flex: 1;
  min-width: 16px;
  height: 1px;
  background-image: linear-gradient(
    to right,
    transparent,
    rgba(var(--ion-color-tertiary-rgb), 0.3)
  );
}
.prose-text :deep(h2.chat-header)::after {
  background-image: linear-gradient(to left, transparent, rgba(var(--ion-color-tertiary-rgb), 0.3));
}

.pdf-card {
  margin: 8px 0;
  padding: 8px 0;
  border-radius: 12px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.2);
  background: rgba(var(--ion-color-primary-rgb), 0.04);
  overflow: hidden;
}
.pdf-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pdf-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 12px;
}
.pdf-title {
  flex: 1 1 auto;
  font-size: 13px;
  line-height: 1.3;
  color: var(--ion-text-color);
}
.pdf-dl {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
  color: var(--ion-color-primary);
  text-decoration: none;
  white-space: nowrap;
}
.pdf-dl:hover {
  text-decoration: underline;
}
.pdf-cta {
  display: block;
  margin-top: 2px;
  padding: 6px 12px;
  border-top: 1px solid rgba(var(--ion-color-primary-rgb), 0.1);
  font-size: 12px;
  color: var(--ion-color-medium);
  text-decoration: none;
}
.pdf-cta:hover {
  color: var(--ion-color-primary);
}
.cite-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  margin: 0 2px;
  border-radius: 999px;
  border: 1px solid var(--ion-color-medium);
  background: rgba(var(--ion-color-medium-rgb), 0.1);
  color: var(--ion-color-medium);
  font-size: 12px;
  font-weight: 500;
  vertical-align: baseline;
  white-space: nowrap;
}
</style>

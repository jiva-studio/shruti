<script setup lang="ts">
import { computed } from 'vue'
// REAL reused app code (single source of truth):
import { parseChatMarkers, type ChatToken } from '@shruti/composables/chatMarkers/parse.js'
import VerseCard from '@shruti/views/Chat/components/VerseCard.vue'
import ChapterCard from '@shruti/views/Chat/components/ChapterCard.vue'
import CitationCard from '@shruti/views/Chat/components/CitationCard.vue'
import CommentaryCard from '@shruti/views/Chat/components/CommentaryCard.vue'
import MediaCard from '@shruti/views/Chat/components/MediaCard.vue'
import NotesInlinePlayer from '@shruti/views/Notes/NotesInlinePlayer.vue'
import OutlineCard from '@shruti/views/Chat/components/OutlineCard.vue'
import { STORE } from '../../i18n/ui'

const props = defineProps<{
  text: string
  lang: 'ru' | 'en'
  verses?: Map<string, any>
  chapters?: Map<string, any>
  cites?: Map<string, any>
  commentaries?: Map<string, any>
  media?: Map<string, any>
  outlines?: Map<string, any>
  pdfActions?: Map<string, any>
}>()

const tokens = computed<ChatToken[]>(() => parseChatMarkers(props.text))

const outlineLabel = computed(() => (props.lang === 'ru' ? 'Оглавление' : 'Outline'))

function verseBody(t: any) {
  return props.verses?.get(`${t.sourceId}|${t.tokens}`)
}
function chapterBody(t: any) {
  return props.chapters?.get(`${t.sourceId}|${t.regionToken}`)
}
function citeBody(t: any) {
  return props.cites?.get(`${t.trackId}|${t.startMs}-${t.endMs}`)
}
function commentaryBody(t: any) {
  return props.commentaries?.get(String(t.ref))
}
function mediaBody(t: any) {
  return props.media?.get(t.mediaId)
}
function outlineBody(t: any) {
  return props.outlines?.get(t.trackId)
}
function pdfBody(t: any) {
  return props.pdfActions?.get(t.actionId)
}

const S3_BASE = 'https://cdn-s3.shruti.local'

function pdfItems(t: any): any[] {
  const body = pdfBody(t)
  return Array.isArray(body?.items) ? body.items : []
}
function pdfTrackId(it: any): string {
  return it.track_id ?? it.trackId ?? ''
}
function pdfTitle(it: any): string {
  return it.title || pdfTrackId(it)
}
function pdfUrl(it: any): string {
  const trackId = pdfTrackId(it)
  const lang = it.lang || props.lang || 'ru'
  return `${S3_BASE}/public/tracks/${trackId}/exports/${lang}.pdf`
}

const pdfLabel = computed(() => (props.lang === 'ru' ? 'Скачать PDF' : 'Download PDF'))
const getAppLabel = computed(() =>
  props.lang === 'ru' ? 'Открыть в приложении' : 'Open in the app'
)

const CHAT = (import.meta.env.PUBLIC_CHAT_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

async function webCut(args: {
  sourceKey: string
  startMs: number
  endMs: number
  excerptId: string
}): Promise<{ url: string; ready: boolean }> {
  const r = await fetch(`${CHAT}/share/audio/excerpts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_key: args.sourceKey,
      start_ms: args.startMs,
      end_ms: args.endMs,
      excerpt_id: args.excerptId,
    }),
  })
  if (!r.ok && r.status !== 202) throw new Error('cut_failed')
  const j = await r.json()
  return { url: j.url, ready: j.ready }
}
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
      <VerseCard
        v-else-if="tk.kind === 'verse'"
        :source-id="tk.sourceId"
        :tokens="tk.tokens"
        :caption="tk.caption"
        :body="verseBody(tk)"
        :locale="lang"
      >
        <template #spinner><span class="dots-spinner" /></template>
      </VerseCard>

      <!-- CHAPTER: real ChapterCard when the payload streamed, else a chip -->
      <ChapterCard
        v-else-if="tk.kind === 'chapter'"
        :source-id="tk.sourceId"
        :region-token="tk.regionToken"
        :caption="tk.caption"
        :body="chapterBody(tk)"
      />

      <!-- CITE: real CitationCard with the transcript snippet, else a chip.
           #player reuses the REAL NotesInlinePlayer with web cut/predict
           adapters. -->
      <CitationCard
        v-else-if="tk.kind === 'cite'"
        :body="citeBody(tk)"
        :caption="tk.caption"
        :language="lang"
      >
        <template v-if="citeBody(tk)" #player>
          <NotesInlinePlayer
            :note="{
              noteId: 'chat-cite-' + tk.trackId + '-' + tk.startMs + '-' + tk.endMs,
              sourceKey: 'public/tracks/' + tk.trackId + '/audio/original.mp3',
              timeStart: tk.startMs,
              timeEnd: tk.endMs,
            }"
            :cut="webCut"
            :predict-url="(id) => 'https://cdn-s3.shruti.local/public/shares/audio/' + id + '.mp3'"
          >
            <template #spinner><span class="dots-spinner" /></template>
          </NotesInlinePlayer>
        </template>
      </CitationCard>

      <!-- COMMENTARY: real CommentaryCard; default translation-notice slot
           works on web via the global $t. Absent body → nothing. -->
      <CommentaryCard
        v-else-if="tk.kind === 'commentary'"
        :body="commentaryBody(tk)"
      />

      <!-- MEDIA: real MediaCard; payload.url is already absolute on web, so
           resolve-url is identity. Icon slots filled with inline SVGs. -->
      <MediaCard
        v-else-if="tk.kind === 'media'"
        :payload="mediaBody(tk)"
        :resolve-url="(u) => u"
      >
        <template #play-icon="{ size }">
          <svg viewBox="0 0 24 24" :width="size" :height="size" fill="currentColor" aria-hidden="true"><path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z" /></svg>
        </template>
        <template #pause-icon="{ size }">
          <svg viewBox="0 0 24 24" :width="size" :height="size" fill="currentColor" aria-hidden="true"><path d="M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" /><path d="M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" /></svg>
        </template>
        <template #expand-icon="{ size }">
          <svg viewBox="0 0 24 24" :width="size" :height="size" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6" /></svg>
        </template>
      </MediaCard>

      <!-- OUTLINE: real OutlineCard when the payload streamed, else a chip. -->
      <template v-else-if="tk.kind === 'outline'">
        <OutlineCard
          v-if="outlineBody(tk)"
          :track-id="tk.trackId"
          :items="outlineBody(tk).items"
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

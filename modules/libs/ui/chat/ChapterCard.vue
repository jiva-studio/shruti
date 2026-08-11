<template>
  <!--
    Chapter-location card — the locate intent's answer to "where in
    scripture is this?". Block-level: region heading (canto title / book
    name) + the list of chapters the narrative spans, each "N. Title".
    Renders only when the message carries this region's `body` (server
    streamed it via `chapter_payload` during the turn). Falls back to an
    inline chip when missing.
  -->
  <ScriptureBlock v-if="body">
    <header v-if="body.regionLabel" class="chapter-card-region">{{ body.regionLabel }}</header>
    <ul class="chapter-card-list">
      <li v-for="c in body.chapters" :key="c.tokens" class="chapter-card-item">
        <span class="chapter-card-num">{{ chapterNumber(c.tokens) }}</span>
        <span class="chapter-card-title">{{ chapterTitle(c) }}</span>
      </li>
    </ul>
  </ScriptureBlock>
  <ScriptureChip
    v-else
    :caption="displayCaption"
    :aria-label="ariaLabel"
    caption-max-width="22ch"
    @tap="onTap"
  />

  <TranslationNotice v-if="isMt" v-model:show-original="showOriginal" />
</template>

<script setup lang="ts">
/**
 * Chapter-location widget. Two render modes (mirrors `VerseCard`):
 *
 *  - body present → block card: region heading + chapter list.
 *  - body missing → inline chip with the region label.
 *
 * Body comes from the owning message's `chapters` map (stashed there from
 * the `chapter_payload` SSE event during the turn and persisted). Titles
 * are read verbatim from the payload (server-side from `library_titles`) —
 * never composed on-device.
 *
 * When citation translation is on the server machine-translates each title
 * into the answer language and ships the source-language one on
 * `titleOriginal`. The card discloses that with the same TranslationNotice
 * its four sibling cards use — an MT'd canto title must never be presented
 * as the book's own wording.
 */
import { computed, ref } from "vue"
import type { UiChatChapterBody } from "./types.js"
import ScriptureChip from "./ScriptureChip.vue"
import ScriptureBlock from "./ScriptureBlock.vue"
import TranslationNotice from "./TranslationNotice.vue"

const props = defineProps<{
  sourceId: string
  regionToken: string
  caption?: string
  /** Chapter region from the message's `chapters` map; absent ⇒ chip. */
  body?: UiChatChapterBody
}>()

const body = computed(() => props.body ?? null)

const displayCaption = computed(
  () => props.caption?.trim() || body.value?.regionLabel || props.regionToken
)
const ariaLabel = computed(() => `Scripture location ${displayCaption.value}`)

// The badge earns its place only when there is an original to flip TO —
// `mt` alone (with every `titleOriginal` dropped) would offer a toggle that
// changes nothing.
const isMt = computed<boolean>(
  () => !!body.value?.mt && !!body.value.chapters.some((c) => !!c.titleOriginal)
)
const showOriginal = ref(false)

function chapterTitle(c: UiChatChapterBody["chapters"][number]): string {
  return showOriginal.value && c.titleOriginal ? c.titleOriginal : c.title
}

// Chapter number = the last dot-segment of the token ("7.5" → "5",
// "2" → "2"). Language-neutral, so no i18n needed for the row prefix.
function chapterNumber(tokens: string): string {
  return tokens.split(",")[0].split(".").pop() ?? tokens
}

function onTap() {
  // Chip-fallback affordance only; the block card already shows the list.
  console.info("[ChapterCard] tap", { sourceId: props.sourceId, regionToken: props.regionToken })
}
</script>

<style scoped>
/* Block layout + the gradient dividers live in the shared `.scripture-block`
 * class (theme/misc.css); only chapter-specific content styling is below. */
.chapter-card-region {
  font-weight: 700;
  font-size: 0.88em;
  text-align: center;
  color: var(--ion-color-primary);
  margin: 0 0 6px;
}
.chapter-card-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.chapter-card-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 0;
}
.chapter-card-num {
  flex: 0 0 auto;
  min-width: 1.5em;
  text-align: right;
  font-weight: 600;
  color: var(--ion-color-medium);
}
.chapter-card-title {
  flex: 1 1 auto;
}
</style>

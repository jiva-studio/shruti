<template>
  <!--
    Chapter-location card — the locate intent's answer to "where in
    scripture is this?". Block-level: region heading (canto title / book
    name) + the list of chapters the narrative spans, each "N. Title".
    Renders only when the message carries this region's `body` (server
    streamed it via `chapter_payload` during the turn). Falls back to an
    inline chip when missing.
  -->
  <article v-if="body" class="chapter-card">
    <header v-if="body.regionLabel" class="chapter-card-region">{{ body.regionLabel }}</header>
    <ul class="chapter-card-list">
      <li v-for="c in body.chapters" :key="c.tokens" class="chapter-card-item">
        <span class="chapter-card-num">{{ chapterNumber(c.tokens) }}</span>
        <span class="chapter-card-title">{{ c.title }}</span>
      </li>
    </ul>
  </article>
  <span
    v-else
    role="button"
    tabindex="0"
    class="chapter-chip"
    :aria-label="ariaLabel"
    @click="onTap"
    @keydown.enter.space.prevent="onTap"
  >
    <IconBook2 :size="14" stroke="1.75" class="chapter-icon" />
    <span class="chapter-caption">{{ displayCaption }}</span>
  </span>
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
 */
import { computed } from "vue"
import { IconBook2 } from "@tabler/icons-vue"
import type { ChatChapterBody } from "@lib/domain/chatMessage.js"

const props = defineProps<{
  sourceId: string
  regionToken: string
  caption?: string
  /** Chapter region from the message's `chapters` map; absent ⇒ chip. */
  body?: ChatChapterBody
}>()

const body = computed(() => props.body ?? null)

const displayCaption = computed(
  () => props.caption?.trim() || body.value?.regionLabel || props.regionToken
)
const ariaLabel = computed(() => `Scripture location ${displayCaption.value}`)

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
.chapter-card {
  position: relative;
  display: block;
  margin: 10px 0;
  padding: 10px 0;
  font-size: 14px;
  line-height: 1.45;
}
.chapter-card::before,
.chapter-card::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background-image: linear-gradient(
    to right,
    transparent,
    rgba(var(--ion-color-tertiary-rgb), 0.1),
    transparent
  );
  pointer-events: none;
}
.chapter-card::before {
  top: 0;
}
.chapter-card::after {
  bottom: 0;
}
/* Adjacent chapter cards (locate returned several regions): the previous
 * card's bottom band + this card's top band would render as a double rule.
 * Drop the runner-up's top band and collapse its top margin/padding so a
 * single shared divider sits between them — same as stacked verse cards. */
.chapter-card + .chapter-card {
  margin-top: 0;
  padding-top: 0;
}
.chapter-card + .chapter-card::before {
  display: none;
}
.chapter-card-region {
  font-weight: 700;
  font-size: 13px;
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

.chapter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  margin: 0 2px;
  border-radius: 999px;
  border: 1px solid var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.08);
  color: var(--ion-color-primary);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  vertical-align: baseline;
  transition: background 0.15s ease;
}
.chapter-chip:hover,
.chapter-chip:focus-visible {
  background: rgba(var(--ion-color-primary-rgb), 0.18);
  outline: none;
}
.chapter-icon {
  flex: 0 0 auto;
}
.chapter-caption {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 22ch;
}
</style>

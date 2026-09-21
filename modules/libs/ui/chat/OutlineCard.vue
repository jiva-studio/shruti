<script setup lang="ts">
import { computed, ref } from "vue"

interface OutlineItem {
  readonly startMs: number
  readonly title: string
}

const props = defineProps<{
  trackId: string
  items: readonly OutlineItem[]
  /** Resolved lecture title. Supplied by the parent (it owns the track-title
   *  load + content-language resolution). Empty/omitted hides the header. */
  trackTitle?: string
  /** Dims the chapter rows and takes them out of the tab order — used while
   *  the daily chat quota is exhausted, since a chapter tap asks for a recap
   *  turn the store will refuse. Only the rows: the header and the "+N"
   *  expander open the lecture / show more text, and neither sends. */
  disabled?: boolean
}>()

/** Tap on a chapter. Carries the item itself + the next item (for end-of-
 *  chapter bound). The controller composes the recap prompt + focus
 *  fragment and dispatches via the chat store — this card stays pure
 *  presentation. */
const emit = defineEmits<{
  "pick-chapter": [
    args: {
      trackId: string
      item: OutlineItem
      nextItem: OutlineItem | null
    },
  ]
  /** Tap on the header → open the lecture. The parent navigates. */
  "open-lecture": [args: { trackId: string; startMs: number }]
}>()

const COLLAPSED_LIMIT = 7
const expanded = ref(false)

const hidden = computed(() =>
  expanded.value ? 0 : Math.max(0, props.items.length - COLLAPSED_LIMIT)
)
const visibleItems = computed(() =>
  expanded.value ? props.items : props.items.slice(0, COLLAPSED_LIMIT)
)

// Local mm:ss / h:mm:ss formatter (no @lectorium dependency). Zero-pads M
// and S for tabular alignment; H stays unpadded.
function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00"
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

function openLecture(startMs: number): void {
  emit("open-lecture", { trackId: props.trackId, startMs })
}

/** User tapped chapter `i` → notify the controller. The controller owns
 *  prompt assembly + chat.sendMessage, this card just signals intent. */
function onPickChapter(i: number): void {
  if (props.disabled) return
  const it = props.items[i]
  if (!it) return
  const next = props.items[i + 1] ?? null
  emit("pick-chapter", { trackId: props.trackId, item: it, nextItem: next })
}
</script>

<template>
  <section v-if="items.length" class="outline-card">
    <button v-if="trackTitle" type="button" class="head" @click="openLecture(0)">
      <span class="lecture-title">{{ trackTitle }}</span>
    </button>
    <ul class="list">
      <li v-for="(it, i) in visibleItems" :key="`${it.startMs}-${i}`">
        <button type="button" class="chapter" :disabled="disabled" @click="onPickChapter(i)">
          <span class="ts">{{ formatTimestamp(it.startMs) }}</span>
          <span class="cap">{{ it.title }}</span>
        </button>
      </li>
    </ul>
    <button v-if="hidden > 0" type="button" class="expand" @click="expanded = true">
      <slot name="more" :n="hidden">+{{ hidden }}</slot>
    </button>
  </section>
</template>

<style scoped>
.outline-card {
  margin: 8px 0;
  /* Zero horizontal padding so :active highlights inside rows extend
   * edge-to-edge across the card. overflow:hidden clips the highlight
   * to the rounded corners. */
  padding: 4px 0;
  border-radius: 12px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.2);
  background: rgba(var(--ion-color-primary-rgb), 0.04);
  overflow: hidden;
}

.head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  border-bottom: 1px solid rgba(var(--ion-color-primary-rgb), 0.1);
  -webkit-tap-highlight-color: transparent;
}

.head:active {
  background: rgba(var(--ion-color-primary-rgb), 0.06);
}

.lecture-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
  /* Truncate to one line — the full title is on the lecture page. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.list {
  list-style: none;
  margin: 0;
  padding: 2px 0;
}

.chapter {
  display: flex;
  gap: 8px;
  align-items: baseline;
  width: 100%;
  padding: 4px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  color: var(--ion-text-color);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.3;
}

.chapter:active:not(:disabled) {
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}

/* Same dimming as the chat chips, which go dead in the same lockout. */
.chapter:disabled {
  opacity: 0.45;
  cursor: default;
}

.ts {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  opacity: 0.5;
  min-width: 36px;
}

.cap {
  flex: 1 1 auto;
  font-weight: 400;
}

.expand {
  display: block;
  width: 100%;
  margin: 2px 0 0;
  padding: 5px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  font-size: 12px;
  color: var(--ion-color-primary);
  cursor: pointer;
}
</style>

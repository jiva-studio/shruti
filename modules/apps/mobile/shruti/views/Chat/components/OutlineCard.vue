<template>
  <section v-if="items.length" class="outline-card">
    <button v-if="trackTitle" type="button" class="head" @click="openLecture(0)">
      <span class="lecture-title">{{ trackTitle }}</span>
    </button>
    <ul class="list">
      <li v-for="(it, i) in visibleItems" :key="`${it.startMs}-${i}`">
        <button type="button" class="chapter" @click="onPickChapter(i)">
          <span class="ts">{{ formatTimestamp(it.startMs) }}</span>
          <span class="cap">{{ it.title }}</span>
        </button>
      </li>
    </ul>
    <button v-if="hidden > 0" type="button" class="expand" @click="expanded = true">
      {{ $t("chat.outlineMore", { n: hidden }) }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import router from "@shruti/router/index.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { formatTimestamp } from "@shruti/composables/formatTimestamp.js"
import { preferredContentLanguage, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import type { TrackId } from "@lib/domain/core.js"

interface OutlineItem {
  readonly startMs: number
  readonly title: string
}

const props = defineProps<{
  trackId: string
  items: readonly OutlineItem[]
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
}>()

// Singleton import — see NotesView.controller for the why.
const app = useShruti()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()

const COLLAPSED_LIMIT = 7
const expanded = ref(false)
const trackTitle = ref<string>("")

const hidden = computed(() =>
  expanded.value ? 0 : Math.max(0, props.items.length - COLLAPSED_LIMIT)
)
const visibleItems = computed(() =>
  expanded.value ? props.items : props.items.slice(0, COLLAPSED_LIMIT)
)

async function loadTitle(): Promise<void> {
  try {
    const t = await app.repositories().tracks.getById(props.trackId as TrackId)
    if (t) {
      const contentLang = preferredContentLanguage(t, libraryLanguages.value, appLanguage.value)
      trackTitle.value = resolveTrackTitle(t, contentLang ?? appLanguage.value) ?? ""
    }
  } catch {
    /* keep empty — header still renders the "Оглавление" label */
  }
}

function openLecture(startMs: number): void {
  // TrackView already handles `resumeFromMs` query — used by CitationChip.
  void router.push({
    name: "track",
    params: { trackId: props.trackId },
    query: startMs > 0 ? { resumeFromMs: String(startMs) } : undefined,
  })
}

/** User tapped chapter `i` → notify the controller. The controller owns
 *  prompt assembly + chat.sendMessage, this card just signals intent. */
function onPickChapter(i: number): void {
  const it = props.items[i]
  if (!it) return
  const next = props.items[i + 1] ?? null
  emit("pick-chapter", { trackId: props.trackId, item: it, nextItem: next })
}

onMounted(loadTitle)
watch(() => props.trackId, loadTitle)
</script>

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

.chapter:active {
  background: rgba(var(--ion-color-primary-rgb), 0.08);
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

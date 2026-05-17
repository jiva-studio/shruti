<template>
  <section v-if="items.length" class="outline-card">
    <button v-if="trackTitle" type="button" class="head" @click="openLecture(0)">
      <span class="lecture-title">{{ trackTitle }}</span>
    </button>
    <ul class="list">
      <li v-for="(it, i) in visibleItems" :key="`${it.startMs}-${i}`">
        <button type="button" class="chapter" @click="onPickChapter(i)">
          <span class="ts">{{ formatTs(it.startMs) }}</span>
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
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { resolveTrackTitle } from "@shruti/composables/resolveLocalized.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import type { TrackId } from "@lib/domain/core.js"

interface OutlineItem {
  readonly startMs: number
  readonly title: string
}

const props = defineProps<{
  trackId: string
  items: readonly OutlineItem[]
}>()

const { t } = useI18n()
const router = useRouter()
const app = useShruti()
const appLanguage = useAppLanguage()
const chat = useChatStore()

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
    if (t) trackTitle.value = resolveTrackTitle(t, appLanguage.value) ?? ""
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

/** Default chapter window when there's no "next" item to bound it. */
const FALLBACK_CHAPTER_MS = 5 * 60 * 1000

/** User tapped chapter `i` → send a "recap this segment" turn with the
 *  range tagged as `focus` in user_context. The agent uses it as the
 *  anchor for get_transcript_window. */
function onPickChapter(i: number): void {
  const it = props.items[i]
  if (!it) return
  const next = props.items[i + 1]
  const endMs = next ? Math.max(next.startMs, it.startMs + 1000) : it.startMs + FALLBACK_CHAPTER_MS
  const text = t("chat.outlineRecapPrompt", {
    from: formatTs(it.startMs),
    to: formatTs(endMs),
    title: it.title,
  })
  void chat.sendMessage(text, {
    focus: {
      track_id: props.trackId,
      start_ms: it.startMs,
      end_ms: endMs,
      title: it.title,
    },
  })
}

/** Always zero-pad MM and SS so every timestamp has the same width
 *  (e.g. "05:47" not "5:47"). Combined with `tabular-nums` in CSS,
 *  the column stays perfectly aligned. */
function formatTs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = (s % 3600) / 60
  const sec = s % 60
  const pad = (n: number) => (n < 10 ? `0${Math.floor(n)}` : String(Math.floor(n)))
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
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
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.20);
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
  border-bottom: 1px solid rgba(var(--ion-color-primary-rgb), 0.10);
  -webkit-tap-highlight-color: transparent;
}

.head:active { background: rgba(var(--ion-color-primary-rgb), 0.06); }

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

.chapter:active { background: rgba(var(--ion-color-primary-rgb), 0.08); }

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

<template>
  <div class="flex h-[calc(100dvh-4rem)] flex-col bg-cream">
    <div class="flex min-h-0 flex-1">
      <section class="app-scroll min-h-0 flex-1 overflow-y-auto">
        <slot v-if="$slots.left" name="left" />

        <WebLectureSearch
          v-else-if="!selectedId"
          :lang="lang"
          embedded
          selectable
          :selected-id="selectedId"
          @select="onSelect"
        />

        <div v-else-if="loading" class="p-10 text-center text-medium">{{ t('app.loading') }}</div>

        <div v-else-if="loadError" class="mx-auto max-w-2xl p-10 text-center">
          <p class="text-medium">{{ t('app.notAvailable') }}</p>
          <button
            type="button"
            class="mt-5 rounded-full border border-line bg-cream-deep px-4 py-1.5 text-sm font-medium text-coffee"
            @click="backToList"
          >
            ← {{ t('app.backToList') }}
          </button>
        </div>

        <div v-else-if="lecture" class="relative py-6">
          <button
            type="button"
            class="absolute left-4 top-6 z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-cream-deep text-coffee"
            :aria-label="t('app.backToList')"
            :title="t('app.backToList')"
            @click="backToList"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <div class="mx-auto max-w-3xl px-5">
            <h1 class="font-serif text-2xl font-bold text-ink">{{ selectedTitle }}</h1>
            <p v-if="selectedMeta" class="mt-2 text-sm text-medium">{{ selectedMeta }}</p>
            <WebLecturePlayer :lecture="lecture" :lang="lang" sticky-top="0px" class="mt-5" />
          </div>
        </div>
      </section>

      <div class="relative hidden w-px shrink-0 bg-line/70 xl:block">
        <div
          class="absolute inset-y-0 -left-2 -right-2 z-10 cursor-col-resize"
          @pointerdown="startResize"
        />
      </div>

      <section class="hidden min-h-0 shrink-0 xl:block" :style="{ width: chatWidth + 'px' }">
        <ChatApp :lang="lang" :track-id="selectedId ?? undefined" bare />
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onBeforeUnmount } from 'vue'
import type { LectureIndexEntry, LectureRecord } from '@lib/catalog/types.js'
import WebLectureSearch from './WebLectureSearch.vue'
import WebLecturePlayer from './WebLecturePlayer.vue'
import ChatApp from './ChatApp.vue'
import { useT, type Lang } from '../../i18n/ui'
import { lectureTitle, lectureMeta } from '../../lib/lectureDisplay'
import indexRaw from '../../data/lectures-index.json'

const props = defineProps<{ lang: Lang; slug?: string; lecture?: LectureRecord | null }>()
const t = useT(props.lang)

const basePath = `/${props.lang}/app`

function shortSlug(slug: string): string {
  return slug.replace(/^track_/, '')
}

const entryBySlug = new Map<string, LectureIndexEntry>()
for (const e of indexRaw as unknown as LectureIndexEntry[]) entryBySlug.set(shortSlug(e.slug), e)

// Lecture records are static files under public/data/lectures/, fetched on
// demand for in-app navigation. NOT bundled via import.meta.glob — globbing
// 5466 JSONs explodes into 5466 Vite chunks and OOMs the client build.
async function loadLecture(id: string): Promise<LectureRecord> {
  const res = await fetch(`/data/lectures/${id}.json`)
  if (!res.ok) throw new Error(`lecture ${id}: ${res.status}`)
  return (await res.json()) as LectureRecord
}

const chatWidth = ref(440)

function startResize(event: PointerEvent) {
  event.preventDefault()
  const onMove = (e: PointerEvent) => {
    const w = window.innerWidth - e.clientX
    chatWidth.value = Math.min(Math.max(w, 320), window.innerWidth * 0.7)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    document.body.style.userSelect = ''
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

const initialEntry = props.slug ? entryBySlug.get(props.slug) ?? null : null
const selectedId = ref<string | null>(initialEntry?.id ?? null)
const selectedEntry = ref<LectureIndexEntry | null>(initialEntry)
const lecture = shallowRef<LectureRecord | null>(props.lecture ?? null)
const loading = ref(false)
const loadError = ref(false)

const selectedTitle = computed(() =>
  selectedEntry.value ? lectureTitle(selectedEntry.value, props.lang) : ''
)

const selectedMeta = computed(() =>
  selectedEntry.value ? lectureMeta(selectedEntry.value, props.lang) : ''
)

async function select(entry: LectureIndexEntry, push = true) {
  if (selectedId.value === entry.id && lecture.value) return
  selectedId.value = entry.id
  selectedEntry.value = entry
  loadError.value = false
  if (push && typeof window !== 'undefined') {
    window.history.pushState(null, '', `${basePath}/${shortSlug(entry.slug)}`)
  }
  if (props.lecture && props.lecture.id === entry.id) {
    lecture.value = props.lecture
    return
  }
  lecture.value = null
  loading.value = true
  try {
    lecture.value = await loadLecture(entry.id)
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

function onSelect(entry: LectureIndexEntry) {
  void select(entry, true)
}

function backToList(push = true) {
  selectedId.value = null
  selectedEntry.value = null
  lecture.value = null
  loadError.value = false
  if (push && typeof window !== 'undefined') {
    window.history.pushState(null, '', basePath)
  }
}

function syncFromPath() {
  const m = window.location.pathname.replace(/\/$/, '').match(/\/app\/([^/]+)$/)
  const slug = m ? m[1] : null
  if (slug) {
    const entry = entryBySlug.get(slug)
    if (entry) void select(entry, false)
    else backToList(false)
  } else {
    backToList(false)
  }
}

onMounted(() => window.addEventListener('popstate', syncFromPath))
onBeforeUnmount(() => window.removeEventListener('popstate', syncFromPath))
</script>

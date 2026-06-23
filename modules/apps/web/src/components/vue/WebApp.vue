<template>
  <div class="flex h-[calc(100dvh-4rem)] flex-col bg-cream">
    <div class="flex min-h-0 flex-1">
      <section class="app-scroll min-h-0 flex-1 overflow-y-auto">
        <WebLectureSearch
          v-if="!selectedId"
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
            class="mt-5 rounded-full border border-line bg-cream-deep px-4 py-1.5 text-sm font-medium text-coffee transition hover:border-saffron/50"
            @click="backToList"
          >
            ← {{ t('app.backToList') }}
          </button>
        </div>

        <div v-else-if="lecture" class="mx-auto max-w-3xl px-5 py-6">
          <button
            type="button"
            class="mb-4 inline-flex items-center gap-1 text-sm font-medium text-coffee transition hover:text-saffron"
            @click="backToList"
          >
            ← {{ t('app.backToList') }}
          </button>
          <h1 class="mb-3 font-serif text-2xl font-bold text-ink">{{ selectedTitle }}</h1>
          <p v-if="selectedMeta" class="mb-5 text-sm text-medium">{{ selectedMeta }}</p>
          <WebLecturePlayer :lecture="lecture" :lang="lang" sticky-top="0px" />
        </div>
      </section>

      <div class="relative w-px shrink-0 bg-line">
        <div
          class="absolute inset-y-0 -left-2 -right-2 z-10 cursor-col-resize"
          @pointerdown="startResize"
        />
      </div>

      <section class="min-h-0 shrink-0" :style="{ width: chatWidth + 'px' }">
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

function pick(map: Record<string, string>): string {
  return map[props.lang] || Object.values(map)[0] || ''
}

const selectedTitle = computed(() =>
  selectedEntry.value ? pick(selectedEntry.value.titles) || selectedEntry.value.id : ''
)

const selectedMeta = computed(() => {
  const e = selectedEntry.value
  if (!e) return ''
  const author = pick(e.authorNames)
  const location = pick(e.locationNames)
  const year = e.date ? e.date.slice(0, 4) : ''
  return [author, location, year].filter(Boolean).join(' · ')
})

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

function toggleClass(active: boolean): string {
  const base = 'rounded-full border px-4 py-1.5 text-sm font-medium transition'
  return active
    ? `${base} border-saffron/60 bg-saffron/10 text-saffron-shade`
    : `${base} border-line bg-cream-deep text-medium hover:border-saffron/50`
}
</script>

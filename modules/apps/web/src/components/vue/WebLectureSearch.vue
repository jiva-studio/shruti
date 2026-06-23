<template>
  <div ref="rootEl" :class="embedded ? 'mx-auto max-w-3xl px-5 py-6' : 'mx-auto max-w-5xl px-5 py-8'">
    <h1 v-if="!embedded" class="mb-4 font-serif text-3xl font-bold text-ink">{{ t('search.title') }}</h1>

    <input
      v-model="query"
      type="search"
      :placeholder="t('search.searchPlaceholder')"
      class="w-full rounded-2xl border border-line bg-cream-deep px-5 py-3.5 text-lg text-ink outline-none transition placeholder:text-medium focus:border-saffron/60"
    />

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <details name="search-filter" class="relative">
        <summary :class="facetSummaryClass(selectedAuthors.length)">
          {{ t('search.author') }}<span v-if="selectedAuthors.length"> · {{ selectedAuthors.length }}</span>
        </summary>
        <div :class="popoverClass">
          <label v-for="a in authorOptions" :key="a.id" :class="checkRowClass">
            <input type="checkbox" :value="a.id" v-model="selectedAuthors" class="facet-check" />
            <span class="truncate">{{ a.label }}</span>
          </label>
        </div>
      </details>

      <details name="search-filter" class="relative">
        <summary :class="facetSummaryClass(selectedLocations.length)">
          {{ t('search.location') }}<span v-if="selectedLocations.length"> · {{ selectedLocations.length }}</span>
        </summary>
        <div :class="popoverClass">
          <label v-for="l in locationOptions" :key="l.id" :class="checkRowClass">
            <input type="checkbox" :value="l.id" v-model="selectedLocations" class="facet-check" />
            <span class="truncate">{{ l.label }}</span>
          </label>
        </div>
      </details>

      <details name="search-filter" class="relative">
        <summary :class="facetSummaryClass(selectedLanguages.length)">
          {{ t('search.language') }}<span v-if="selectedLanguages.length"> · {{ selectedLanguages.length }}</span>
        </summary>
        <div :class="popoverClass">
          <label v-for="lng in languageOptions" :key="lng.id" :class="checkRowClass">
            <input type="checkbox" :value="lng.id" v-model="selectedLanguages" class="facet-check" />
            <span>{{ lng.label }}</span>
          </label>
        </div>
      </details>

      <details name="search-filter" class="relative">
        <summary :class="facetSummaryClass(yearFrom || yearTo ? 1 : 0)">
          {{ t('search.year') }}<span v-if="yearFrom || yearTo"> · {{ yearFrom || '…' }}–{{ yearTo || '…' }}</span>
        </summary>
        <div :class="popoverClass" class="flex gap-2">
          <div class="min-w-0 flex-1">
            <p class="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-medium">{{ t('search.yearFrom') }}</p>
            <button type="button" :class="optionRowClass(!yearFrom)" @click="yearFrom = ''; closeDetails($event)">—</button>
            <button
              v-for="y in years"
              :key="'f' + y"
              type="button"
              :class="optionRowClass(yearFrom === y)"
              @click="yearFrom = y; closeDetails($event)"
            >
              {{ y }}
            </button>
          </div>
          <div class="min-w-0 flex-1">
            <p class="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-medium">{{ t('search.yearTo') }}</p>
            <button type="button" :class="optionRowClass(!yearTo)" @click="yearTo = ''; closeDetails($event)">—</button>
            <button
              v-for="y in years"
              :key="'t' + y"
              type="button"
              :class="optionRowClass(yearTo === y)"
              @click="yearTo = y; closeDetails($event)"
            >
              {{ y }}
            </button>
          </div>
        </div>
      </details>

      <details name="search-filter" class="relative">
        <summary :class="facetSummaryClass(duration ? 1 : 0)">
          {{ t('search.duration') }}<span v-if="durationLabel"> · {{ durationLabel }}</span>
        </summary>
        <div :class="popoverClass">
          <button type="button" :class="optionRowClass(!duration)" @click="duration = ''; closeDetails($event)">—</button>
          <button
            type="button"
            :class="optionRowClass(duration === 'short')"
            @click="duration = 'short'; closeDetails($event)"
          >
            {{ t('search.durationShort') }}
          </button>
          <button
            type="button"
            :class="optionRowClass(duration === 'medium')"
            @click="duration = 'medium'; closeDetails($event)"
          >
            {{ t('search.durationMedium') }}
          </button>
          <button
            type="button"
            :class="optionRowClass(duration === 'long')"
            @click="duration = 'long'; closeDetails($event)"
          >
            {{ t('search.durationLong') }}
          </button>
        </div>
      </details>

      <details name="search-filter" class="relative">
        <summary :class="facetSummaryClass(sort !== 'newest' ? 1 : 0)">{{ t('search.sort') }} · {{ sortLabel }}</summary>
        <div :class="popoverClass">
          <button
            type="button"
            :class="optionRowClass(sort === 'newest')"
            @click="sort = 'newest'; closeDetails($event)"
          >
            {{ t('search.sortNewest') }}
          </button>
          <button
            type="button"
            :class="optionRowClass(sort === 'oldest')"
            @click="sort = 'oldest'; closeDetails($event)"
          >
            {{ t('search.sortOldest') }}
          </button>
          <button
            type="button"
            :class="optionRowClass(sort === 'reference')"
            @click="sort = 'reference'; closeDetails($event)"
          >
            {{ t('search.sortReference') }}
          </button>
        </div>
      </details>

      <button type="button" :class="resetClass" @click="reset">{{ t('search.reset') }}</button>
    </div>

    <p class="mt-5 text-sm text-medium">{{ t('search.resultsCount') }}: {{ filtered.length }}</p>

    <div v-if="filtered.length" class="mt-3 flex flex-col">
      <template v-for="(entry, i) in visible" :key="entry.id">
        <WebLectureRow
          :entry="entry"
          :lang="lang"
          :href="selectable ? undefined : hrefFor(entry)"
          :selected="entry.id === selectedId"
          @select="emit('select', entry)"
        />
        <div v-if="i < visible.length - 1" class="row-divider" aria-hidden="true" />
      </template>
    </div>

    <p v-else class="mt-6 text-medium">{{ t('search.noResults') }}</p>

    <nav v-if="filtered.length && pageCount > 1" class="mt-6 flex flex-wrap items-center justify-center gap-1.5">
      <button type="button" :class="pagerBtn" :disabled="page === 1" aria-label="Prev" @click="goTo(page - 1)">‹</button>
      <template v-for="(p, i) in pageWindow" :key="i">
        <span v-if="p === '…'" class="px-1 text-sm text-medium">…</span>
        <button
          v-else
          type="button"
          :class="[pagerBtn, p === page ? 'border-saffron/60 bg-saffron/10 text-saffron-shade' : '']"
          @click="goTo(p)"
        >
          {{ p }}
        </button>
      </template>
      <button type="button" :class="pagerBtn" :disabled="page === pageCount" aria-label="Next" @click="goTo(page + 1)">›</button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LectureIndexEntry } from '@lib/catalog/types.js'
import { useT, type Lang } from '../../i18n/ui'
import indexRaw from '../../data/lectures-index.json'
import WebLectureRow from './WebLectureRow.vue'

const props = withDefaults(
  defineProps<{
    lang: Lang
    embedded?: boolean
    selectable?: boolean
    selectedId?: string | null
  }>(),
  { embedded: false, selectable: false, selectedId: null }
)
const t = useT(props.lang)

const emit = defineEmits<{ select: [entry: LectureIndexEntry] }>()

const index = indexRaw as unknown as LectureIndexEntry[]

const PER_PAGE = 25

const page = ref(1)
const query = ref('')
const debounced = ref('')
const selectedAuthors = ref<string[]>([])
const selectedLocations = ref<string[]>([])
const selectedLanguages = ref<string[]>([])
const yearFrom = ref('')
const yearTo = ref('')
const duration = ref('')
const sort = ref('newest')

let debounceTimer: ReturnType<typeof setTimeout> | undefined
watch(query, (v) => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounced.value = v
  }, 150)
})

function norm(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function pick(map: Record<string, string>): string {
  if (map[props.lang]) return map[props.lang]
  const first = Object.values(map)[0]
  return first ?? ''
}

const haystacks = new WeakMap<LectureIndexEntry, string>()
function haystackFor(entry: LectureIndexEntry): string {
  const cached = haystacks.get(entry)
  if (cached !== undefined) return cached
  const parts: string[] = []
  for (const v of Object.values(entry.titles)) parts.push(v)
  for (const v of Object.values(entry.authorNames)) parts.push(v)
  for (const v of Object.values(entry.locationNames)) parts.push(v)
  for (const r of entry.refs) {
    for (const v of Object.values(r.shortNames)) parts.push(v)
    parts.push(r.tokens)
  }
  const h = norm(parts.join(' '))
  haystacks.set(entry, h)
  return h
}

const languageNames: Record<string, Record<Lang, string>> = {
  en: { ru: 'Английский', en: 'English' },
  ru: { ru: 'Русский', en: 'Russian' },
}
function languageLabel(code: string): string {
  return languageNames[code]?.[props.lang] ?? code
}

const authorOptions = computed(() => {
  const map = new Map<string, string>()
  for (const e of index) if (e.authorId && !map.has(e.authorId)) map.set(e.authorId, pickFrom(e.authorNames))
  return [...map].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
})

const locationOptions = computed(() => {
  const map = new Map<string, string>()
  for (const e of index) if (e.locationId && !map.has(e.locationId)) map.set(e.locationId, pickFrom(e.locationNames))
  return [...map].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
})

const languageOptions = computed(() => {
  const set = new Set<string>()
  for (const e of index) for (const c of e.contentLanguages) set.add(c)
  return [...set].sort().map((id) => ({ id, label: languageLabel(id) }))
})

const years = computed(() => {
  const set = new Set<string>()
  for (const e of index) if (e.date) set.add(e.date.slice(0, 4))
  return [...set].sort((a, b) => b.localeCompare(a))
})

function pickFrom(map: Record<string, string>): string {
  return pick(map) || Object.values(map)[0] || ''
}

const filtered = computed<LectureIndexEntry[]>(() => {
  const tokens = norm(debounced.value).split(/\s+/).filter(Boolean)
  const yf = yearFrom.value
  const yt = yearTo.value
  const out = index.filter((e) => {
    if (tokens.length) {
      const h = haystackFor(e)
      for (const tok of tokens) if (!h.includes(tok)) return false
    }
    if (selectedAuthors.value.length && (!e.authorId || !selectedAuthors.value.includes(e.authorId))) return false
    if (selectedLocations.value.length && (!e.locationId || !selectedLocations.value.includes(e.locationId)))
      return false
    if (selectedLanguages.value.length && !e.contentLanguages.some((c) => selectedLanguages.value.includes(c)))
      return false
    if (yf || yt) {
      if (!e.date) return false
      const y = e.date.slice(0, 4)
      if (yf && y < yf) return false
      if (yt && y > yt) return false
    }
    if (duration.value) {
      if (e.durationMs == null) return false
      const m = e.durationMs
      if (duration.value === 'short' && !(m < 20 * 60000)) return false
      if (duration.value === 'medium' && !(m >= 20 * 60000 && m <= 60 * 60000)) return false
      if (duration.value === 'long' && !(m > 60 * 60000)) return false
    }
    return true
  })
  return sortEntries(out)
})

function refSortKey(e: LectureIndexEntry): string {
  const r = e.refs[0]
  if (!r) return ''
  const short = r.shortNames[props.lang] ?? Object.values(r.shortNames)[0] ?? ''
  return norm(`${short} ${r.tokens}`.trim())
}

function sortEntries(arr: LectureIndexEntry[]): LectureIndexEntry[] {
  const a = [...arr]
  if (sort.value === 'reference') {
    a.sort((x, y) => {
      const kx = refSortKey(x)
      const ky = refSortKey(y)
      if (!kx && !ky) return 0
      if (!kx) return 1
      if (!ky) return -1
      return kx.localeCompare(ky)
    })
    return a
  }
  const dir = sort.value === 'oldest' ? 1 : -1
  a.sort((x, y) => {
    if (!x.date && !y.date) return 0
    if (!x.date) return 1
    if (!y.date) return -1
    return x.date < y.date ? -dir : x.date > y.date ? dir : 0
  })
  return a
}

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PER_PAGE)))

const visible = computed(() => {
  const start = (page.value - 1) * PER_PAGE
  return filtered.value.slice(start, start + PER_PAGE)
})

// Windowed page list: 1 … (cur-2 … cur+2) … last.
const pageWindow = computed<(number | '…')[]>(() => {
  const total = pageCount.value
  const cur = page.value
  const span = 2
  const out: (number | '…')[] = []
  const from = Math.max(1, cur - span)
  const to = Math.min(total, cur + span)
  if (from > 1) {
    out.push(1)
    if (from > 2) out.push('…')
  }
  for (let p = from; p <= to; p++) out.push(p)
  if (to < total) {
    if (to < total - 1) out.push('…')
    out.push(total)
  }
  return out
})

function goTo(p: number) {
  page.value = Math.min(Math.max(1, p), pageCount.value)
  rootEl.value?.scrollIntoView({ block: 'start' })
}

// Any filter/query change resets to the first page.
watch([debounced, selectedAuthors, selectedLocations, selectedLanguages, yearFrom, yearTo, duration, sort], () => {
  page.value = 1
})

function hrefFor(e: LectureIndexEntry): string {
  return `/${props.lang}/app/${e.slug.replace(/^track_/, '')}`
}

function reset() {
  query.value = ''
  debounced.value = ''
  selectedAuthors.value = []
  selectedLocations.value = []
  selectedLanguages.value = []
  yearFrom.value = ''
  yearTo.value = ''
  duration.value = ''
  sort.value = 'newest'
  page.value = 1
}

const durationLabel = computed(() => {
  if (duration.value === 'short') return t('search.durationShort')
  if (duration.value === 'medium') return t('search.durationMedium')
  if (duration.value === 'long') return t('search.durationLong')
  return ''
})

const sortLabel = computed(() => {
  if (sort.value === 'oldest') return t('search.sortOldest')
  if (sort.value === 'reference') return t('search.sortReference')
  return t('search.sortNewest')
})

function closeDetails(e: Event) {
  ;(e.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
}

const rootEl = ref<HTMLElement | null>(null)
function closeOnOutside(e: PointerEvent) {
  const root = rootEl.value
  if (!root) return
  const target = e.target as Node
  for (const d of root.querySelectorAll<HTMLDetailsElement>('details[open]')) {
    if (!d.contains(target)) d.removeAttribute('open')
  }
}
onMounted(() => document.addEventListener('pointerdown', closeOnOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOnOutside))

const popoverClass =
  'absolute z-10 mt-2 max-h-72 w-72 overflow-y-auto rounded-2xl border border-line bg-cream-deep p-2'
const checkRowClass = 'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink'

function optionRowClass(active: boolean): string {
  const base = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition'
  return active ? `${base} bg-saffron/10 text-saffron-shade` : `${base} text-ink`
}

const resetClass =
  'rounded-full border border-line bg-cream-deep px-4 py-1.5 text-sm font-medium text-coffee transition'

const pagerBtn =
  'grid h-9 min-w-9 place-items-center rounded-lg border border-line px-2.5 text-sm font-medium text-coffee transition disabled:opacity-40'

function facetSummaryClass(count: number): string {
  const base =
    'cursor-pointer list-none rounded-full border px-4 py-1.5 text-sm font-medium transition'
  return count
    ? `${base} border-saffron/60 bg-saffron/10 text-saffron-shade`
    : `${base} border-line bg-cream-deep text-ink`
}
</script>

<style scoped>
.facet-check {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  width: 1.15rem;
  height: 1.15rem;
  border-radius: 0.375rem;
  border: 1.5px solid var(--color-line);
  background-color: var(--color-cream);
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}
.facet-check:checked {
  border-color: var(--color-saffron);
  background-color: var(--color-saffron);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23faf5ea' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 0.72rem;
}

.row-divider {
  height: 1px;
  margin: 0 1rem;
  background: linear-gradient(
    to right,
    transparent,
    var(--shruti-divider, rgba(0, 0, 0, 0.07)),
    transparent
  );
  pointer-events: none;
}
</style>

<template>
  <div ref="rootEl" :class="embedded ? 'mx-auto max-w-3xl px-5 py-6' : 'mx-auto max-w-5xl px-5 py-8'">
    <h1 v-if="!embedded" class="mb-4 font-serif text-3xl font-bold text-ink">{{ t('search.title') }}</h1>

    <input
      v-model="query"
      type="search"
      :placeholder="t('search.searchPlaceholder')"
      class="w-full rounded-2xl border border-line bg-cream-deep px-5 py-3.5 text-lg text-ink outline-none transition placeholder:text-medium focus:border-saffron/60"
    />

    <SearchFilters
      v-model:authors="selectedAuthors"
      v-model:locations="selectedLocations"
      v-model:languages="selectedLanguages"
      v-model:yearFrom="yearFrom"
      v-model:yearTo="yearTo"
      v-model:duration="duration"
      v-model:sort="sort"
      :t="t"
      :author-options="authorOptions"
      :location-options="locationOptions"
      :language-options="languageOptions"
      :years="years"
      @reset="reset"
    />

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
import { ref, watch } from 'vue'
import type { LectureIndexEntry } from '@lib/catalog/types.js'
import { useT, type Lang } from '../../i18n/ui'
import indexRaw from '../../data/lectures-index.json'
import WebLectureRow from './WebLectureRow.vue'
import SearchFilters from './SearchFilters.vue'
import { useSearchFilter } from '../../composables/useSearchFilter'
import { usePagination } from '../../composables/usePagination'

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

const rootEl = ref<HTMLElement | null>(null)

const {
  query,
  debounced,
  selectedAuthors,
  selectedLocations,
  selectedLanguages,
  yearFrom,
  yearTo,
  duration,
  sort,
  authorOptions,
  locationOptions,
  languageOptions,
  years,
  filtered,
  reset: resetFilter,
} = useSearchFilter(index, () => props.lang)

const { page, pageCount, visible, pageWindow, goTo } = usePagination(filtered, PER_PAGE, () =>
  rootEl.value?.scrollIntoView({ block: 'start' })
)

watch([debounced, selectedAuthors, selectedLocations, selectedLanguages, yearFrom, yearTo, duration, sort], () => {
  page.value = 1
})

function hrefFor(e: LectureIndexEntry): string {
  return `/${props.lang}/app/${e.slug.replace(/^track_/, '')}`
}

function reset() {
  resetFilter()
  page.value = 1
}

const pagerBtn =
  'grid h-9 min-w-9 place-items-center rounded-lg border border-line px-2.5 text-sm font-medium text-coffee transition disabled:opacity-40'
</script>

<style scoped>
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

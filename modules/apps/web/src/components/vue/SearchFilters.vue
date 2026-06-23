<template>
  <div ref="rootEl" class="mt-4 flex flex-wrap items-center gap-2">
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

    <button type="button" :class="resetClass" @click="emit('reset')">{{ t('search.reset') }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { UiKey } from '../../i18n/ui'
import type { FacetOption, SortMode } from '../../composables/useSearchFilter'

const props = defineProps<{
  t: (key: UiKey) => string
  authorOptions: FacetOption[]
  locationOptions: FacetOption[]
  languageOptions: FacetOption[]
  years: string[]
}>()

const emit = defineEmits<{ reset: [] }>()

const selectedAuthors = defineModel<string[]>('authors', { required: true })
const selectedLocations = defineModel<string[]>('locations', { required: true })
const selectedLanguages = defineModel<string[]>('languages', { required: true })
const yearFrom = defineModel<string>('yearFrom', { required: true })
const yearTo = defineModel<string>('yearTo', { required: true })
const duration = defineModel<string>('duration', { required: true })
const sort = defineModel<SortMode>('sort', { required: true })

const durationLabel = computed(() => {
  if (duration.value === 'short') return props.t('search.durationShort')
  if (duration.value === 'medium') return props.t('search.durationMedium')
  if (duration.value === 'long') return props.t('search.durationLong')
  return ''
})

const sortLabel = computed(() => {
  if (sort.value === 'oldest') return props.t('search.sortOldest')
  if (sort.value === 'reference') return props.t('search.sortReference')
  return props.t('search.sortNewest')
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
  return active ? `${base} bg-saffron/10 text-saffron-shade` : `${base} text-ink hover:bg-saffron/5`
}

const resetClass =
  'rounded-full border border-line bg-cream-deep px-4 py-1.5 text-sm font-medium text-coffee transition'

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
</style>

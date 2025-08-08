<template>
  <SearchFilterChipsList>
    <TransitionGroup
      name="chips"
      tag="div"
      class="chips-wrap"
    >
      <div
        v-for="chip in sortedChips"
        :key="chip.key"
        class="chip-item"
      >
        <!-- MULTI: string[] + items -->
        <component
          :is="chip.component"
          v-if="chip.kind === 'multi'"
          v-model="(value[chip.model] as string[] | undefined)"
          :items="dictionary[chip.itemsKey]"
          :title="$t(chip.titleKey)"
        >
          <template #icon>
            <component :is="chip.icon" />
          </template>
        </component>

        <!-- SINGLE: string + items -->
        <component
          :is="chip.component"
          v-else-if="chip.kind === 'single'"
          v-model="(value[chip.model] as string | undefined)"
          :items="dictionary[chip.itemsKey]"
          :title="$t(chip.titleKey)"
        >
          <template #icon>
            <component :is="chip.icon" />
          </template>
        </component>

        <!-- DATE: {from,to} no items -->
        <component
          :is="chip.component"
          v-else
          v-model="(value.dates)"
          :title="$t(chip.titleKey)"
        >
          <template #icon>
            <component :is="chip.icon" />
          </template>
        </component>
      </div>
    </TransitionGroup>
  </SearchFilterChipsList>
</template>

<script lang="ts" setup>
import { type Component, computed } from 'vue'
import { useI18n } from 'vue-i18n'

import SearchFilterChipsList from './SearchFilterChipsList.vue'
import SearchFilterChipWithListItem from './SearchFilterChipWithListItem.vue'
import SearchFilterChipWithListItems from './SearchFilterChipWithListItems.vue'
import SearchFilterChipWithDateRange from './SearchFilterChipWithDateRange.vue'
import { useSearchFiltersDictionaryStore } from '../composables/useSearchFiltersDictionaryStore'

import IconLanguages from '../icons/IconLanguages.vue'
import IconAuthors from '../icons/IconAuthors.vue'
import IconSources from '../icons/IconSources.vue'
import IconLocations from '../icons/IconLocations.vue'
import IconDates from '../icons/IconDates.vue'
import IconSort from '../icons/IconSort.vue'
import IconClock from '../icons/IconClock.vue'

/* -------------------------------------------------------------------------- */
/*                                   Models                                   */
/* -------------------------------------------------------------------------- */

export type SearchFilters = {
  authors?: string[]
  sources?: string[]
  locations?: string[]
  languages?: string[]
  duration?: string
  dates?: { from: string, to: string }
  sort?: 'reference' | 'date'
}
type MultiModel = 'languages'|'authors'|'sources'|'locations'
type SingleModel = 'duration'|'sort'

type BaseChip<K extends keyof SearchFilters> = {
  key: K
  model: K
  titleKey: string
  icon: Component
}

type MultiChip = BaseChip<MultiModel> & {
  kind: 'multi'
  component: typeof SearchFilterChipWithListItems
  itemsKey: 'languages'|'authors'|'sources'|'locations'
}

type SingleChip = BaseChip<SingleModel> & {
  kind: 'single'
  component: typeof SearchFilterChipWithListItem
  itemsKey: 'durations'|'sort'
}

type DateChip = BaseChip<'dates'> & {
  kind: 'date'
  component: typeof SearchFilterChipWithDateRange
  itemsKey: null
}

type ChipDef = MultiChip | SingleChip | DateChip

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const { t } = useI18n()
const dictionary = useSearchFiltersDictionaryStore()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = defineModel<SearchFilters>({ required: true })

const sortedChips = computed(() => {
  const v = value.value // make it reactive
  return [...chips].sort((a, b) => {
    const aHas = hasValue(v, a.model as keyof SearchFilters)
    const bHas = hasValue(v, b.model as keyof SearchFilters)
    if (aHas !== bHas) return aHas ? -1 : 1
    return t(a.titleKey).toString().localeCompare(t(b.titleKey).toString())
  })
})

const chips = [
  { kind: 'multi',  key: 'languages', component: SearchFilterChipWithListItems, model: 'languages', itemsKey: 'languages', titleKey: 'search.filters.languages', icon: IconLanguages },
  { kind: 'multi',  key: 'authors',   component: SearchFilterChipWithListItems, model: 'authors',   itemsKey: 'authors',   titleKey: 'search.filters.authors',   icon: IconAuthors },
  { kind: 'multi',  key: 'sources',   component: SearchFilterChipWithListItems, model: 'sources',   itemsKey: 'sources',   titleKey: 'search.filters.sources',   icon: IconSources },
  { kind: 'multi',  key: 'locations', component: SearchFilterChipWithListItems, model: 'locations', itemsKey: 'locations', titleKey: 'search.filters.locations', icon: IconLocations },
  { kind: 'single', key: 'duration',  component: SearchFilterChipWithListItem,  model: 'duration',  itemsKey: 'durations', titleKey: 'search.filters.duration',  icon: IconClock },
  { kind: 'date',   key: 'dates',     component: SearchFilterChipWithDateRange, model: 'dates',     itemsKey: null,        titleKey: 'search.filters.dates',     icon: IconDates },
  { kind: 'single', key: 'sort',      component: SearchFilterChipWithListItem,  model: 'sort',      itemsKey: 'sort',      titleKey: 'search.filters.sort',      icon: IconSort },
] as const satisfies readonly ChipDef[]

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function hasValue(v: SearchFilters, model: keyof SearchFilters) {
  const cur = (v as any)[model]
  if (Array.isArray(cur)) return cur.length > 0
  if (model === 'dates') return !!(cur?.from || cur?.to)
  return cur !== undefined && cur !== null && cur !== ''
}

</script>

<style scoped>
.chips-wrap {
  display: flex;
  gap: 8px;
}

.chip-item {
  display: inline-flex;
}

.chips-move {
  transition: transform 500ms ease;
}
</style>

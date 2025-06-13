<template>
  <SearchFilterChipsList>
    <SearchFilterChipWithListItem
      v-model="value.sort"
      :items="dictionary.sort"
      :title="$t('search.filters.sort')"
    />
    <SearchFilterChipWithListItems
      v-model="value.authors"
      :items="dictionary.authors"
      :title="$t('search.filters.authors')"
    />
    <SearchFilterChipWithListItems
      v-model="value.sources"
      :items="dictionary.sources"
      :title="$t('search.filters.sources')"
    />
    <SearchFilterChipWithListItems
      v-model="value.locations" 
      :items="dictionary.locations"
      :title="$t('search.filters.locations')"
    />
    <SearchFilterChipWithListItems
      v-model="value.languages"
      :items="dictionary.languages"
      :title="$t('search.filters.languages')"
    />
    <SearchFilterChipWithListItem
      v-model="value.duration"
      :items="dictionary.durations"
      :title="$t('search.filters.duration')"
    />
    <SearchFilterChipWithDateRange
      v-model="value.dates" 
      :title="$t('search.filters.dates')"
    />
  </SearchFilterChipsList>
</template>


<script lang="ts" setup>
import SearchFilterChipsList from './SearchFilterChipsList.vue'
import SearchFilterChipWithListItem from './SearchFilterChipWithListItem.vue'
import SearchFilterChipWithListItems from './SearchFilterChipWithListItems.vue'
import SearchFilterChipWithDateRange from './SearchFilterChipWithDateRange.vue'
import { useSearchFiltersDictionaryStore } from '../composables/useSearchFiltersDictionaryStore'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
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

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dictionary = useSearchFiltersDictionaryStore()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = defineModel<SearchFilters>({ required: true })
</script>
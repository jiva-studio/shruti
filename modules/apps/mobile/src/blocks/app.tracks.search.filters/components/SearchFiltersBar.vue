<template>
  <SearchFilterChipsList>
    <SearchFilterChipWithListItems
      v-model="value.languages"
      :items="dictionary.languages"
      :title="$t('search.filters.languages')"
    >
      <template #icon>
        <IconLanguages />
      </template>
    </SearchFilterChipWithListItems>

    <SearchFilterChipWithListItems
      v-model="value.authors"
      :items="dictionary.authors"
      :title="$t('search.filters.authors')"
    >
      <template #icon>
        <IconAuthors />
      </template>
    </SearchFilterChipWithListItems>

    <SearchFilterChipWithListItems
      v-model="value.sources"
      :items="dictionary.sources"
      :title="$t('search.filters.sources')"
    >
      <template #icon>
        <IconSources />
      </template>
    </SearchFilterChipWithListItems>

    <SearchFilterChipWithListItems
      v-model="value.locations" 
      :items="dictionary.locations"
      :title="$t('search.filters.locations')"
    >
      <template #icon>
        <IconLocations />
      </template>
    </SearchFilterChipWithListItems>
  
    <SearchFilterChipWithListItem
      v-model="value.duration"
      :items="dictionary.durations"
      :title="$t('search.filters.duration')"
    >
      <template #icon>
        <IconClock />
      </template>
    </SearchFilterChipWithListItem>


    <SearchFilterChipWithDateRange
      v-model="value.dates" 
      :title="$t('search.filters.dates')"
    >
      <template #icon>
        <IconDates />
      </template>
    </SearchFilterChipWithDateRange>


    <SearchFilterChipWithListItem
      v-model="value.sort"
      :items="dictionary.sort"
      :title="$t('search.filters.sort')"
    > 
      <template #icon>
        <IconSort />
      </template>
    </SearchFilterChipWithListItem>
  </SearchFilterChipsList>
</template>


<script lang="ts" setup>
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
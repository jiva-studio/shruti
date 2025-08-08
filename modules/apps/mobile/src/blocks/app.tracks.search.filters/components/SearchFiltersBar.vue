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
        <svg
          class="w-6 h-6 text-gray-800 dark:text-white"
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            fill-rule="evenodd"
            d="M2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10S2 17.523 2 12Zm11-4a1 1 0 1 0-2 0v4a1 1 0 0 0 .293.707l3 3a1 1 0 0 0 1.414-1.414L13 11.586V8Z"
            clip-rule="evenodd"
          />
        </svg>
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
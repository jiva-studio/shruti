<template>
  <Page>
    <Searchbar :placeholder="$t('app.search')" />
    <TracksFilterBar v-model="filters" />
    <TracksSearchResults
      ref="tracksSearchResultsRef"
      :filters="filters"
    />
  </Page>
</template>

<script setup lang="ts">
import { Searchbar, TracksFilterBar, TracksFilterValue, TracksSearchResults } from '@/library'
import { Page, useConfig } from '@/app/'
import { ref, watch } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const tracksSearchResultsRef = ref<typeof TracksSearchResults>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const filters = ref<TracksFilterValue>({
  ids: [],
  authors: [],
  sources: [],
  locations: [],
  languages: [],
  duration: { min: 0, max: Number.MAX_SAFE_INTEGER },
  dates: { from: '', to: '' },
})


/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(config.appLanguage, () => {
  tracksSearchResultsRef.value?.refresh()
})
</script>

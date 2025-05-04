<template>
  <Page>
    <Searchbar
      v-model="query"
      :placeholder="$t('search.search', { count: tracksCount })"
    />
    <TracksFilterBar v-model="filters" />
    <TracksSearchResults
      ref="tracksSearchResultsRef"
      :filters="filters"
    />
  </Page>
</template>

<script setup lang="ts">
import {
  Searchbar, TracksFilterBar, TracksFilterValue, TracksSearchResults,
} from '@lectorium/mobile/search'
import { Page, useConfig, useDAL } from '@lectorium/mobile/app'
import { ref, watch, onMounted } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const dal = useDAL()
const tracksSearchResultsRef = ref<typeof TracksSearchResults>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const query = ref('')

const filters = ref<TracksFilterValue>({
  query: '',
  ids: [],
  authors: [],
  sources: [],
  locations: [],
  languages: [],
  duration: { min: 0, max: Number.MAX_SAFE_INTEGER },
  dates: { from: '', to: '' },
})

const tracksCount = ref<number>(0)

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(query, (newQuery) => {
  filters.value.query = newQuery
})

watch(config.appLanguage, () => {
  tracksSearchResultsRef.value?.refresh()
})

onMounted(async () => {
  tracksCount.value = await dal.tracks.getCount()
})
</script>

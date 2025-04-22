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
import {
  Searchbar, TracksFilterBar, TracksFilterValue, TracksSearchResults,
  useNotifyUserIfNewTrackAddedFeature
} from '@/library'
import { Page, useConfig } from '@/app/'
import { ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const i18n = useI18n()
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

onMounted(() => {
  useNotifyUserIfNewTrackAddedFeature(i18n.t)
})
</script>

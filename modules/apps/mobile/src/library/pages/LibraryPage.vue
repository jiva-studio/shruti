<template>
  <Page>
    <Searchbar placeholder="Search" />
    <TracksFilterBar v-model="filters" />

    <TracksSearchResults
      :filters="filters"
    />
  </Page>
</template>

<script setup lang="ts">
import { Searchbar, TracksFilterBar, TracksFilterValue, TracksSearchResults } from '@/library'
import { Page } from '@/app/'
import { ref } from 'vue'

const filters = ref<TracksFilterValue>({
  ids: [],
  authors: [],
  sources: [],
  locations: [],
  languages: [],
  duration: { min: 0, max: Number.MAX_SAFE_INTEGER },
  dates: { from: '', to: '' },
})
</script>

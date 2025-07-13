<template>
  <Page>
    <!-- Search input text -->
    <SearchInput
      :model-value="trackSearchResultsStore.filters.query"
      :placeholder="$t('search.search', { count: tracksCountStore.totalCount })"
      @update:model-value="onSearchQueryChange"
    />

    <!-- Search filter bar with filter chips -->
    <SearchFiltersBar v-model="trackSearchResultsStore.filters" />

    <!-- Found tracks with state indicator -->
    <SearchResultsSection @click="onTrackClicked">
      <template #state="{ trackId }">
        <TrackStateIndicator :track-id="trackId" />
      </template>
    </SearchResultsSection>
  </Page>
</template>

<script setup lang="ts">
import { useEventBus } from '@lectorium/mobile/core'
import { Page, SearchInput } from '@blocks/app.core'
import { SearchFiltersBar } from '@blocks/app.tracks.search.filters'
import { TrackStateIndicator } from '@blocks/app.tracks.state'
import { SearchResultsSection, useTrackSearchResultsStore } from '@blocks/app.tracks.search.results' 
import { useTracksCountStore } from '@blocks/app.tracks.count'
import { usePlaylist } from '@blocks/app.playlist'
import { useDebounceFn } from '@vueuse/core'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const eventBus = useEventBus()
const trackSearchResultsStore = useTrackSearchResultsStore()
const tracksCountStore = useTracksCountStore()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

const onSearchQueryChange = useDebounceFn((value: string) => {
  trackSearchResultsStore.filters.query = value
}, 200)


async function onTrackClicked(trackId: string) {
  await usePlaylist().add(trackId)
  eventBus.trackDownload.notify({ 
    trackIds: [trackId], 
    skipFailed: false 
  })
}
</script>

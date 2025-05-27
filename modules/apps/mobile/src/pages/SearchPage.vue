<template>
  <Page>
    <!-- Search input text -->
    <SearchInput
      v-model="trackSearchResultsStore.filters.query"
      :placeholder="$t('search.search', { count: tracksCountStore.totalCount })"
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
import { Page, SearchInput } from '@shruti/mobile/features/app.core'
import { SearchFiltersBar } from '@shruti/mobile/features/tracks.search.filters'
import { TrackStateIndicator } from '@shruti/mobile/features/tracks.state'
import { SearchResultsSection, useTrackSearchResultsStore } from '@shruti/mobile/features/tracks.search.results' 
import { useTracksCountStore } from '@shruti/mobile/features/tracks.count'
import { useTracksDownloadFeature } from '@shruti/mobile/features/tracks.download'
import { usePlaylistFeature } from '@shruti/mobile/features/playlist'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const trackSearchResultsStore = useTrackSearchResultsStore()
const tracksCountStore = useTracksCountStore()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onTrackClicked(trackId: string) {
  const isTrackAdded = await usePlaylistFeature().addTrackToPlaylist(trackId)
  if (isTrackAdded) {
    useTracksDownloadFeature().download({ trackId })
  }
}
</script>

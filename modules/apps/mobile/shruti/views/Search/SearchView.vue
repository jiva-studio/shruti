<template>
  <AppPage :player-open="player.open">
    <!-- Search input text -->
    <SearchInput v-model="search.query.value" :placeholder="$t('app.search')" />

    <!-- Search filter bar with filter chips -->
    <SearchFiltersBar
      v-model="search.filters.value"
      :authors-items="search.authorsItems.value"
      :languages-items="search.languagesItems.value"
      :locations-items="search.locationsItems.value"
      :duration-items="search.durationItems.value"
      :sort-items="search.sortItems.value"
      :authors-title="search.authorsTitle.value"
      :languages-title="search.languagesTitle.value"
      :locations-title="search.locationsTitle.value"
      :duration-title="search.durationTitle.value"
      :sort-title="search.sortTitle.value"
      :dates-title="search.datesTitle.value"
    />

    <!-- Results -->
    <IonText v-if="search.error.value" color="danger" class="ion-padding">
      <p>{{ search.error.value }}</p>
    </IonText>
    <TracksList
      :rows="search.rows.value"
      :empty-message="search.emptyMessage.value"
      @select="search.onSelect"
    >
      <template #state="{ state, progressPct }">
        <PlaylistStateIndicator :state="state" :playback-progress="progressPct" />
      </template>
    </TracksList>
    <IonInfiniteScroll :disabled="!search.hasMore.value" @ion-infinite="onInfinite">
      <IonInfiniteScrollContent />
    </IonInfiniteScroll>
  </AppPage>
</template>

<script setup lang="ts">
import {
  IonText,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { AppPage } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { SearchFiltersBar } from "@ui/features/tracks/search/filters/index.js"
import { PlaylistStateIndicator } from "@ui/features/playlist/index.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useSearchController } from "./SearchView.controller.js"

const player = usePlayerStore()
const search = useSearchController()

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await search.loadMore()
  await e.target.complete()
}
</script>

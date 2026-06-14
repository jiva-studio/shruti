<template>
  <IonPage>
    <FlatHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle>{{ $t("search.lecturesTitle") }}</IonTitle>
      </IonToolbar>
      <IonToolbar>
        <div class="search-row">
          <SearchInput v-model="search.query.value" :placeholder="$t('app.search')" />
          <SearchFiltersButton
            class="search-row-filter-button"
            :active="search.activeFilterCount.value > 0"
            :aria-label="$t('search.filtersButton')"
            @click="search.filtersOpen.value = true"
          />
        </div>
      </IonToolbar>
    </FlatHeader>

    <IonContent :fullscreen="true">
      <IonText v-if="search.error.value" color="danger" class="ion-padding">
        <p>{{ search.error.value }}</p>
      </IonText>
      <TracksList
        :rows="search.rows.value"
        :empty-message="search.emptyMessage.value"
        @select="search.onSelect"
      >
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
      <IonInfiniteScroll :disabled="!search.hasMore.value" @ion-infinite="onInfinite">
        <IonInfiniteScrollContent />
      </IonInfiniteScroll>
    </IonContent>

    <SearchFiltersSheet
      v-model:filters="search.filters.value"
      :open="search.filtersOpen.value"
      :sections="search.filterSections.value"
      :can-reset="search.activeFilterCount.value > 0"
      @update:open="search.filtersOpen.value = $event"
      @reset="search.resetFilters"
    />
  </IonPage>
</template>

<script setup lang="ts">
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonPage,
  IonText,
  IonTitle,
  IonToolbar,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { FlatHeader } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import {
  SearchFiltersButton,
  SearchFiltersSheet,
} from "@ui/features/tracks/search/filters/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { useSearchController } from "@shruti/views/Search/SearchView.controller.js"

const search = useSearchController()

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await search.loadMore()
  await e.target.complete()
}
</script>

<style scoped>
.search-row {
  position: relative;
}

.search-row :deep(ion-input) {
  --padding-end: 56px;
}

.search-row-filter-button {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
}
</style>

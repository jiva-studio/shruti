<template>
  <IonPage>
    <FlatHeader>
      <IonToolbar>
        <div class="search-row">
          <SearchInput
            v-model="search.query.value"
            :placeholder="$t('app.search')"
            :leading-label="$t('app.back')"
            @leading-click="onBack"
          >
            <template #leading>
              <IconArrowLeft :size="22" />
            </template>
          </SearchInput>
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

      <!-- Nothing matched the active filters / query: a centered cue that
           points back at the filter sheet (the language facet seeded on first
           launch can hide the whole library for a user whose content language
           differs from the catalog's). -->
      <div v-else-if="search.showEmptyState.value" class="no-results">
        <div class="no-results-badge">
          <IconSearchOff :size="34" />
        </div>
        <b class="no-results-title">{{ $t("search.noResultsTitle") }}</b>
        <span class="no-results-message">{{ $t("search.noResultsMessage") }}</span>
        <IonButton fill="clear" size="small" @click="search.filtersOpen.value = true">
          {{ $t("search.noResultsAction") }}
        </IonButton>
      </div>

      <template v-else>
        <TracksList :rows="search.rows.value" @select="search.onSelect">
          <template #state="{ state, progressPct }">
            <TrackStateIndicator :state="state" :progress="progressPct" />
          </template>
        </TracksList>
        <IonInfiniteScroll :disabled="!search.hasMore.value" @ion-infinite="onInfinite">
          <IonInfiniteScrollContent />
        </IonInfiniteScroll>
      </template>
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
  IonButton,
  IonContent,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonPage,
  IonText,
  IonToolbar,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { useRouter } from "vue-router"
import { IconArrowLeft, IconSearchOff } from "@tabler/icons-vue"
import { FlatHeader } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import {
  SearchFiltersButton,
  SearchFiltersSheet,
} from "@ui/features/tracks/search/filters/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { useSearchController } from "@shruti/views/Search/SearchView.controller.js"

const router = useRouter()
const search = useSearchController()

function onBack(): void {
  router.back()
}

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

.no-results {
  /* Fill the content height so the cue sits centered, not pinned to the top. */
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 24px 16px;
  text-align: center;
}

.no-results-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  margin-bottom: 0.5rem;
  border-radius: 50%;
  background: var(--ion-color-light);
  color: var(--ion-color-medium);
}

.no-results-title {
  font-size: 1.1rem;
  font-weight: 600;
}

.no-results-message {
  max-width: 320px;
  color: var(--ion-color-medium);
}
</style>

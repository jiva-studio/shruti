<template>
  <AppPage :reserve-player-space="player.open">
    <!-- Pinned to the viewport so the tracks list scrolls underneath. The
         gradient's bottom 30% fades to transparent, making list rows
         visually dissolve as they pass under the search bar. -->
    <div class="search-fixed-top">
      <div class="search-row">
        <SearchInput v-model="search.query.value" :placeholder="$t('app.search')" />
        <SearchFiltersButton
          class="search-row-filter-button"
          :active="search.activeFilterCount.value > 0"
          :aria-label="$t('search.filtersButton')"
          @click="search.filtersOpen.value = true"
        />
      </div>
    </div>

    <!-- Reserves vertical room under the fixed header so the first track
         row isn't hidden on initial paint. -->
    <div class="search-content-spacer" />

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

    <SearchFiltersSheet
      v-model:filters="search.filters.value"
      :open="search.filtersOpen.value"
      :sections="search.filterSections.value"
      :can-reset="search.activeFilterCount.value > 0"
      @update:open="search.filtersOpen.value = $event"
      @reset="search.resetFilters"
    />
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
import {
  SearchFiltersButton,
  SearchFiltersSheet,
} from "@ui/features/tracks/search/filters/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useSearchController } from "./SearchView.controller.js"

const player = usePlayerStore()
const search = useSearchController()

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await search.loadMore()
  await e.target.complete()
}
</script>

<style scoped>
.search-fixed-top {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  padding-top: env(safe-area-inset-top);
  /* Extra space below the row where the gradient fades over the
     scrolling track rows so there's no hard edge. */
  padding-bottom: 20px;
  /* Wrapper itself is non-interactive so taps in the fade region hit
     the tracks below; only the search row captures taps. */
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    rgba(var(--lectorium-fade-bg-rgb), 1) 0%,
    rgba(var(--lectorium-fade-bg-rgb), 1) calc(100% - 20px),
    rgba(var(--lectorium-fade-bg-rgb), 0) 100%
  );
}

.search-fixed-top > * {
  pointer-events: auto;
}

.search-row {
  position: relative;
}

/* IonInput renders inside SearchInputAndroid wrapped with `margin: 10px`.
   Push the typed text padding so it never slides under the filter button. */
.search-row :deep(ion-input) {
  --padding-end: 56px;
}

.search-row-filter-button {
  position: absolute;
  /* SearchInputAndroid wraps IonInput with margin: 10px, so the input's
     right border is 10px in from .search-row's right edge. Sit just
     inside that. */
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  /* Stack above IonInput's own hit area so taps land on the button,
     and re-enable interactivity in case an ancestor disabled it
     (.search-fixed-top sets pointer-events: none). */
  z-index: 2;
  pointer-events: auto;
}

/* Spacer reserves room under the fixed header for the first track row.
   IonContent (через AppPage) уже padит safe-area-top через
   --padding-top: var(--ion-safe-area-top), поэтому env() здесь добавлять
   нельзя — на обеих платформах safe-area складывалась бы дважды и
   оставляла пустую полосу высотой с целый элемент. 80px = высота input
   + 20px gradient-fade. */
.search-content-spacer {
  height: 80px;
}

/* IonList ships with a default --padding-top that leaves visible empty
   space above the first row. The search page already reserves vertical
   room via .search-content-spacer + the fixed header's gradient fade,
   so the list's own top padding is redundant and creates a gap big
   enough to fit an extra item. Scope the override to this page so other
   IonList consumers keep Ionic's default rhythm. */
:deep(ion-list) {
  --padding-top: 0;
  padding-top: 0;
}

/* Mirror the page-content constraint on the fixed header so the search
   row stays aligned with the centred content column on wide screens. */
@media (min-width: 768px) {
  .search-fixed-top {
    max-width: var(--lectorium-content-max-width);
    margin-inline: auto;
  }
}
</style>

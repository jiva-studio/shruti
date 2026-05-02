<template>
  <AppPage :reserve-player-space="player.open">
    <!-- Pinned to the viewport so the tracks list scrolls underneath. The
         gradient's bottom 30% fades to transparent, making list rows
         visually dissolve as they pass under the search bar. -->
    <div class="search-fixed-top">
      <SearchInput v-model="search.query.value" :placeholder="$t('app.search')" />
      <SearchFiltersBar v-model="search.filters.value" :chips="search.filterChips.value" />
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
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
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
  /* Extra space below the chips where the gradient fades over the
     scrolling track rows so there's no hard edge. */
  padding-bottom: 40px;
  /* Wrapper itself is non-interactive so taps in the fade region hit
     the tracks below; only the search + chips capture taps. */
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    rgba(var(--ion-background-color-rgb, 255, 255, 255), 1) 0%,
    rgba(var(--ion-background-color-rgb, 255, 255, 255), 1) calc(100% - 40px),
    rgba(var(--ion-background-color-rgb, 255, 255, 255), 0) 100%
  );
}

.search-fixed-top > * {
  pointer-events: auto;
}

.search-content-spacer {
  height: calc(env(safe-area-inset-top) + 116px);
}
</style>

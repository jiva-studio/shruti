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
    <div class="search-content-spacer" :class="{ 'is-android': isAndroid }" />

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
  isPlatform,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { AppPage } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { SearchFiltersBar } from "@ui/features/tracks/search/filters/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useSearchController } from "./SearchView.controller.js"

const player = usePlayerStore()
const search = useSearchController()
// AppPage's IonContent already pads itself by --ion-safe-area-top, and the
// spacer below adds env(safe-area-inset-top) again. On iOS the WebView's
// env() resolves to 0 inside ion-content (only the IonContent root sees the
// inset), so the stack works out. On Android both values are non-zero and
// stack, leaving an empty-row-sized gap above the first result.
const isAndroid = isPlatform("android")

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
    rgba(var(--lectorium-fade-bg-rgb), 1) 0%,
    rgba(var(--lectorium-fade-bg-rgb), 1) calc(100% - 40px),
    rgba(var(--lectorium-fade-bg-rgb), 0) 100%
  );
}

.search-fixed-top > * {
  pointer-events: auto;
}

.search-content-spacer {
  height: calc(env(safe-area-inset-top) + 116px);
}

/* On Android Capacitor's WebView reports env(safe-area-inset-top) as the
   status-bar height *and* IonContent's --padding-top resolves to the same
   --ion-safe-area-top, so adding both stacks an extra inset-row of empty
   space above the first result. Drop the env() term on Android — the
   IonContent padding alone is enough to clear the fixed header. */
.search-content-spacer.is-android {
  height: 116px;
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
   input + filter chips stay aligned with the centred content column on
   wide screens. The gradient narrows along with the wrapper, but the
   page surface beneath it is the same theme background so the fade has
   no visible edge. */
@media (min-width: 768px) {
  .search-fixed-top {
    max-width: var(--lectorium-content-max-width);
    margin-inline: auto;
  }
}
</style>

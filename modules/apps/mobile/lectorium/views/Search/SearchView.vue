<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"
import { IonContent, IonPage } from "@ionic/vue"
import { SafeAreaHeaderGradient } from "@ui/primitives/index.js"
import { SearchFiltersSheet, clearSection } from "@ui/features/tracks/search/filters/index.js"
import { useSearchController } from "./SearchView.controller.js"
import { useWebSearch } from "./composables/useWebSearch.js"
import { useGroupingSearch, type GroupingHit } from "./composables/useGroupingSearch.js"
import SearchLanding from "./components/SearchLanding.vue"
import SearchResults from "./components/SearchResults.vue"
import DockSpacer from "@lectorium/components/DockSpacer.vue"

/**
 * The library tab: one page that browses when there is nothing in the field
 * and searches when there is.
 *
 * These used to be two screens with a banner between them, and the split cost
 * more than it bought — the catalog was somewhere you navigated TO, and the
 * field was only there once you had. Now the field is always at the bottom,
 * where the thumb is, and typing swaps what is above it. No route change: the
 * landing keeps its scroll position and its warmed data, and clearing the field
 * puts it back exactly as it was.
 *
 * `v-show` on the landing rather than `v-if` for that reason. The results are
 * `v-if` — they have nothing to preserve, and not building them is the common
 * case.
 *
 * Both search composables live HERE, not in the results component. They own the
 * filter binding, the loaded dictionaries and the paging cursor; created a
 * level down they would be torn down and rebuilt every time the field emptied,
 * reloading dictionaries on the next keystroke.
 *
 * The field is docked at the root (`App.vue`), next to the player; this page
 * only keeps the space clear for it at the bottom.
 */
const router = useRouter()

const search = useSearchController()
const searching = computed(() => search.query.value.trim().length > 0)

// Collections and topics whose name the query names — the same objects the
// landing browses, matched in memory.
const grouping = useGroupingSearch(search.query)

// Searches only while this page is the one on top: "see all" pushes a page that
// searches the same words itself, and this view stays mounted underneath it —
// without the gate both ask the archives the same question, and only one of them
// is showing. It goes in as `owned`, not folded into `enabled`: an empty field
// clears the lane, whereas being covered must leave the shelf exactly as it was
// found, or every push over this page (the paywall, "see all") empties it.
// What is above the field keeps following `searching` alone, so a page sliding
// back into view does not swap its shape mid-transition.
const web = useWebSearch({
  query: search.query,
  filters: search.filters,
  enabled: searching,
  owned: search.active,
})

/** A collection and a topic each have their own page; the shelf mixes them. */
function openGrouping(hit: GroupingHit): void {
  void router.push(
    hit.kind === "collection"
      ? { name: "collection", params: { id: hit.id } }
      : { name: "topic-tracks", params: { topicId: hit.id } }
  )
}

/** Open the full set of internet results, carrying the query in the URL. */
function openWebResults(): void {
  void router.push({ name: "web-results", query: { q: search.query.value.trim() } })
}

/**
 * Open the personal library narrowed to this query — the page that already
 * lists those items, not a second one built for search.
 */
function openMyLibrary(): void {
  void router.push({ name: "my-library", query: { q: search.query.value.trim() } })
}

/** Drop one section from the chips above the results. */
function onClearFilter(key: string): void {
  search.filters.value = clearSection(search.filters.value, key)
}
</script>

<template>
  <IonPage>
    <SafeAreaHeaderGradient />

    <IonContent :fullscreen="true">
      <div class="page-content">
        <SearchLanding v-show="!searching" />
        <SearchResults
          v-if="searching"
          :search="search"
          :web="web"
          :grouping="grouping"
          @open-filters="search.filtersOpen.value = true"
          @clear-filter="onClearFilter"
          @see-all-web="openWebResults"
          @see-all-mine="openMyLibrary"
          @open-grouping="openGrouping"
        />
      </div>
      <DockSpacer />
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

<style scoped>
ion-content {
  --padding-top: var(--ion-safe-area-top);
}

.page-content {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding-top: 8px;
}

@media (min-width: 768px) {
  .page-content {
    max-width: var(--kit-page-content-max-width);
    margin-inline: auto;
  }
}
</style>

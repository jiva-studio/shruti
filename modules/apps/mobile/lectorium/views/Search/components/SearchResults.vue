<template>
  <div class="results">
    <ActiveFilterChips
      :filters="search.filters.value"
      :sections="search.filterSections.value"
      :default-sections="search.defaultSections.value"
      @open="emit('open-filters')"
      @clear="(key: string) => emit('clear-filter', key)"
    />

    <!-- ── Found on the internet ─────────────────────────────────────────
         First, because it is the part the user cannot get any other way. It is
         also the slow half, so it holds its own space while it loads rather
         than shoving the library results down when it arrives.

         One shelf, one tile — the same one the personal library is made of,
         because that is what a hit becomes the moment somebody adds it.
         "See all" opens the full set on its own page; the shelf stays a
         glance. -->
    <section class="lane">
      <SectionHeader
        :title="$t('search.web.title')"
        :see-all="web.hits.value.length > 0"
        :see-all-label="$t('search.collections.seeAllNamed', { name: $t('search.web.title') })"
        @more="emit('see-all-web')"
      />

      <!-- What the service said about the request itself: a speaker it does not
           know, a field the sentence overruled. Without these an empty lane
           cannot tell "nothing matches" from "nothing could". -->
      <p v-for="(m, i) in web.messages.value" :key="i" class="lane-note">{{ m.text }}</p>

      <!-- The shelf that is coming, drawn empty. A spinner here said "something
           is happening" and nothing about what; five grey tiles say how many
           are on their way and where they will land. -->
      <div v-if="web.isLoadingFirstPage.value" class="carousel">
        <div v-for="n in SKELETON_COUNT" :key="n" class="carousel-cell">
          <TrackTile status="loading" />
        </div>
      </div>

      <div v-else-if="web.error.value" class="lane-state lane-state--muted">
        {{ $t("search.web.unavailable") }}
      </div>

      <div v-else-if="!web.hits.value.length" class="lane-state lane-state--muted">
        {{ $t("search.web.empty") }}
      </div>

      <div v-else class="carousel">
        <div v-for="hit in web.hits.value" :key="hit.item_id" class="carousel-cell">
          <WebTrackCard :hit="hit" />
        </div>
      </div>
    </section>

    <!-- ── Collections and topics ────────────────────────────────────────
         One shelf: to somebody reading results they are the same offer, and
         which table a set came from is our business. The topic carries its "#"
         in its name, which is all that tells them apart. Same card the landing
         uses. -->
    <CarouselSection
      v-if="grouping.items.value.length"
      :title="$t('search.collections.title')"
      :items="grouping.items.value"
      @select="onOpenGrouping"
    />

    <!-- ── Found in the personal library ─────────────────────────────────
         What the user added themselves. Its own shelf rather than mixed into
         the catalog: these are their tracks, and one of them being here is a
         different answer from the corpus holding something. -->
    <section v-if="mine.length" class="lane">
      <SectionHeader
        :title="$t('search.library.mine')"
        see-all
        :see-all-label="$t('search.collections.seeAllNamed', { name: $t('search.library.mine') })"
        @more="emit('see-all-mine')"
      />
      <div class="carousel">
        <div v-for="item in mine" :key="item.id" class="carousel-cell">
          <LibraryItemCard :item="item" @select="onOpenMine" @retry="onRetryMine" />
        </div>
      </div>
    </section>

    <!-- ── Found in the library ──────────────────────────────────────────
         The lectures already on the phone. Local, so it answers instantly. -->
    <section class="lane">
      <SectionHeader :title="$t('search.library.title')" />

      <!-- Named `.no-results` because that is what it is, and because the
           filter sheet is the usual cause: a content language seeded on first
           launch can hide most of the catalog from a user who never chose it. -->
      <div v-if="search.showEmptyState.value" class="no-results">
        <b class="no-results-title">{{ $t("search.noResultsTitle") }}</b>
        <span class="no-results-message">{{ $t("search.library.empty") }}</span>
      </div>
      <template v-else>
        <TracksList flush :rows="search.rows.value" @select="search.onSelect">
          <template #state="{ state, progressPct }">
            <TrackStateIndicator :state="state" :progress="progressPct" />
          </template>
        </TracksList>
        <IonInfiniteScroll :disabled="!search.hasMore.value" @ion-infinite="onInfinite">
          <IonInfiniteScrollContent />
        </IonInfiniteScroll>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import {
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { SectionHeader, CarouselSection } from "@ui/features/collections/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import type { SearchControllerReturn } from "../SearchView.controller.js"
import type { UseWebSearchReturn } from "../composables/useWebSearch.js"
import type { GroupingHit, UseGroupingSearchReturn } from "../composables/useGroupingSearch.js"
import ActiveFilterChips from "./ActiveFilterChips.vue"
import WebTrackCard from "./WebTrackCard.vue"
import TrackTile from "@lectorium/components/TrackTile.vue"
import LibraryItemCard from "@lectorium/views/Library/components/LibraryItemCard.vue"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import { useOpenLibraryItem } from "@lectorium/composables/useOpenLibraryItem.js"
import { useRetryLibraryItem } from "@lectorium/composables/useRetryLibraryItem.js"

/**
 * What a search turned up, in two lanes: lectures on other archives, then the
 * ones already on the phone.
 *
 * The internet lane comes first because it is what the library tab could not
 * do before, and it is where the interesting answer usually is — the local
 * catalog is what the user has already chosen to keep. It is one shelf of the
 * same tile the personal library is made of: a hit is that object already, one
 * nobody has added yet.
 *
 * Both composables are created by the page and passed in, so clearing the
 * field does not tear down the controller and re-run its dictionary load on
 * the next keystroke.
 */
/** Placeholder tiles while the archives answer — about a screenful of shelf. */
const SKELETON_COUNT = 5

const props = defineProps<{
  search: SearchControllerReturn
  web: UseWebSearchReturn
  grouping: UseGroupingSearchReturn
}>()

// The filters are the page's to change, not this component's: it is handed a
// controller to read from, and writing back through it would be reaching into
// somebody else's state.
const emit = defineEmits<{
  "open-filters": []
  "clear-filter": [key: string]
  /** Open the full set of internet results on its own page. */
  "see-all-web": []
  /** Open the personal library, narrowed to this query. */
  "see-all-mine": []
  "open-grouping": [hit: GroupingHit]
}>()

// The user's own tracks whose title the query names. A handful of items, held
// in memory already — the same walk the collections shelf does.
const library = useLibraryStore()
const onOpenMine = useOpenLibraryItem()
const onRetryMine = useRetryLibraryItem()

const mine = computed(() => {
  const needle = props.search.query.value.trim().toLocaleLowerCase()
  if (!needle) return []
  return library.items
    .filter((i) => (i.titleRaw ?? "").toLocaleLowerCase().includes(needle))
    .slice(0, 12)
})

function onOpenGrouping(id: string): void {
  const hit = props.grouping.items.value.find((i) => i.id === id)
  if (hit) emit("open-grouping", hit)
}

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await props.search.loadMore()
  await e.target.complete()
}
</script>

<style scoped>
.results {
  padding-bottom: 8px;
}

.lane {
  margin-bottom: 4px;
}

.lane-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 72px;
  padding: 8px 16px;
  text-align: center;
}

.lane-state--muted {
  color: var(--ion-color-medium);
  font-size: 14px;
}

.no-results {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 16px;
  text-align: center;
}

.no-results-title {
  font-size: 1rem;
  font-weight: 600;
}

.no-results-message {
  max-width: 320px;
  color: var(--ion-color-medium);
  font-size: 14px;
}

.lane-note {
  margin: 0 16px 8px;
  color: var(--ion-color-medium);
  font-size: 13px;
  line-height: 1.35;
}

/* The collection carousel's shelf, to the pixel — same gap, same 16px side
   insets and scroll padding. Two shelves of squares one above the other with
   12px between the tiles on one and 14px on the other reads as two sizes even
   when the tiles match. */
.carousel {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  padding: 0 16px 14px;
  scroll-padding-inline: 16px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.carousel::-webkit-scrollbar {
  display: none;
}

/* One size for every shelf on this page. A collection tile, a track from the
   internet and a track from the personal library are three shelves of squares
   stacked on top of each other, and three widths read as a mistake — so this
   matches `CollectionCard`'s 140px rather than inventing a fourth. */
.carousel-cell {
  flex: 0 0 auto;
  width: 140px;
  scroll-snap-align: start;
}
</style>

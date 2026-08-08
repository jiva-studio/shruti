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
         First, because it is the part the user cannot get any other way.
         It is also the slow half, so it holds its own space while it loads
         rather than shoving the library results down when it arrives. -->
    <section class="lane">
      <SectionHeader :title="$t('search.web.title')" />

      <div v-if="web.isLoadingFirstPage.value" class="lane-state">
        <IonSpinner name="dots" />
      </div>

      <div v-else-if="web.error.value" class="lane-state lane-state--muted">
        {{ $t("search.web.unavailable") }}
      </div>

      <template v-else>
        <!-- What the service said about the request itself: a speaker it does
             not know, a field the sentence overruled. Without these an empty
             lane cannot tell "nothing matches" from "nothing could". -->
        <p v-for="(m, i) in web.messages.value" :key="i" class="lane-note">{{ m.text }}</p>

        <div v-if="withCovers.length" class="carousel">
          <div v-for="hit in withCovers" :key="hit.item_id" class="carousel-cell">
            <WebLectureCard :hit="hit" :cover="coverOf(hit)!" />
          </div>
        </div>

        <template v-if="withoutCovers.length">
          <WebLectureRow v-for="hit in withoutCovers" :key="hit.item_id" :hit="hit" />
        </template>

        <div v-if="!web.hits.value.length" class="lane-state lane-state--muted">
          {{ $t("search.web.empty") }}
        </div>

        <IonButton
          v-if="web.hasMore.value"
          class="more"
          fill="clear"
          size="small"
          :disabled="web.isLoading.value"
          @click="web.loadMore()"
        >
          {{ $t("search.web.more") }}
        </IonButton>
      </template>
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
        <TracksList :rows="search.rows.value" @select="search.onSelect">
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
  IonButton,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonSpinner,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { SectionHeader } from "@ui/primitives/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import type { DiscoveryHit } from "@lib/contracts"
import { youtubeCoverUrl } from "@lectorium/utils/youtubeCover.js"
import type { SearchControllerReturn } from "../SearchView.controller.js"
import type { UseWebSearchReturn } from "../composables/useWebSearch.js"
import ActiveFilterChips from "./ActiveFilterChips.vue"
import WebLectureCard from "./WebLectureCard.vue"
import WebLectureRow from "./WebLectureRow.vue"

/**
 * What a search turned up, in two lanes: lectures on other archives, then the
 * ones already on the phone.
 *
 * The internet lane comes first because it is what the library tab could not
 * do before, and it is where the interesting answer usually is — the local
 * catalog is what the user has already chosen to keep. Within it the shape
 * follows the source material: recordings published as video have a poster and
 * ride a carousel, files on a web server have none and read as rows. That is
 * the only reason there are two shapes, and it is decided by the address (see
 * `youtubeCoverUrl`) rather than by a stored column.
 *
 * Both composables are created by the page and passed in, so clearing the
 * field does not tear down the controller and re-run its dictionary load on
 * the next keystroke.
 */
const props = defineProps<{
  search: SearchControllerReturn
  web: UseWebSearchReturn
}>()

// The filters are the page's to change, not this component's: it is handed a
// controller to read from, and writing back through it would be reaching into
// somebody else's state.
const emit = defineEmits<{ "open-filters": []; "clear-filter": [key: string] }>()

function coverOf(hit: DiscoveryHit): string | null {
  return youtubeCoverUrl(hit.media_url, hit.page_url)
}

const withCovers = computed(() => props.web.hits.value.filter((h) => coverOf(h) !== null))
const withoutCovers = computed(() => props.web.hits.value.filter((h) => coverOf(h) === null))

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

/* Same horizontal shelf as the collection carousels: 16px side insets and
   scroll padding so the first and last card get an edge gutter. */
.carousel {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  padding: 0 16px 12px;
  scroll-padding-inline: 16px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.carousel::-webkit-scrollbar {
  display: none;
}

.carousel-cell {
  flex: 0 0 auto;
  width: 220px;
  scroll-snap-align: start;
}

.more {
  margin-inline-start: 8px;
}

/* The section header owns the 6px gap below it; cancel each content type's
   own intrinsic top so nothing adds to it. */
:deep(ion-list) {
  --padding-top: 0;
  padding-top: 0;
  margin-top: -7px;
}
</style>

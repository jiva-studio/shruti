<script setup lang="ts">
import { computed, watch } from "vue"
import { useRouter } from "vue-router"
import { IonSpinner, onIonViewWillEnter } from "@ionic/vue"
import { SectionHeader, CarouselSection, TileSection } from "@ui/features/collections/index.js"
import TrackRowsList from "@lectorium/views/components/TrackRowsList.vue"
import CollectionRows from "./CollectionRows.vue"
import MyLibraryShelf from "@lectorium/views/Library/components/MyLibraryShelf.vue"
import SmartLibraryEntry from "./SmartLibraryEntry.vue"
import { useRecommendationsStore } from "@lectorium/stores/useRecommendationsStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useLibraryLandingStore } from "@lectorium/stores/useLibraryLandingStore.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import type { TrackId } from "@lib/domain/core.js"

const router = useRouter()
const app = useLectorium()
const appLanguage = useAppLanguage()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()
const recommendations = useRecommendationsStore()
const dictionaries = useDictionariesStore()
// All the section data (collection groups, lecture pool, lecture count) loads as
// one batch behind `landing.ready`, warmed at app startup — so the page renders
// fully formed instead of popping its sections in one by one. The lecture count
// is scoped to the user's chosen library content languages so it matches what
// the tracks search lists.
const landing = useLibraryLandingStore()
const libraryLanguages = useLibraryLanguages()
// Reload the batch when the UI or library languages change (no-op otherwise);
// the store keeps the current content visible until the new set is ready.
watch([appLanguage, libraryLanguages], () => void landing.ensureLoaded())
void landing.ensureLoaded()

// "Recommended for you" picks + per-hot-topic shelves, derived on-device from
// the listening profile (see useRecommendationsStore). SHELF_PREVIEW caps the
// inline rows; "see all" opens the full topic-tracks view.
const recommendedRows = mapper.mapRows(() => recommendations.recommended, { context: "discovery" })

// Topics are shown two ways: a grid of tiles ("Темы"), and — lower down — the
// user's three most-listened topics as title + lectures shelves. The tile grid
// (and its cover prewarm) is derived in the landing store, which already skips
// the shelf topics; here we only build the shelves themselves.
const SHELF_PREVIEW = 3
const topicShelves = computed(() =>
  recommendations.shelves.map((s) => ({
    topicId: s.topicId,
    name: dictionaries.topicNamesById.get(s.topicId) ?? s.topicId,
    // Same `context` as every other shelf on this page — the landing is a
    // discovery surface end to end. Without it the shelves read row state from
    // the playlist context, so one track could show a progress radial here and
    // a checkmark in "Recommended for you" two sections up (#1615).
    rows: s.tracks
      .slice(0, SHELF_PREVIEW)
      .map((tr) => mapper.toUiRow(tr, { context: "discovery" })),
  }))
)

// Topic and collection cards navigate to the shared detail page (same
// component, different kind).
function onSelectTopic(topicId: string): void {
  void app.haptics.impact("light")
  void router.push({ name: "topic-tracks", params: { topicId } })
}

// The shown subsets — and the prewarm of their covers — are derived once per
// load in the landing store, so the view just renders them: no picking logic
// and no image-cache warming in the component.
const topGroups = computed(() => landing.topGroups)
const otherCollections = computed(() => landing.otherCollections)
const topicTiles = computed(() => landing.topicTiles)

// mapRows keeps row state live and, in "discovery" context, folds playback
// progress to the binary state discovery surfaces use.
const previewLectures = mapper.mapRows(() => landing.lectureSample, { context: "discovery" })

onIonViewWillEnter(() => {
  // Ensure the batch is loaded (no-op once warmed at startup). Recommendations
  // are part of that batch (built once in the landing load, like collections
  // and topics) — we deliberately don't rebuild them on every entry, which used
  // to reshuffle and visibly swap the "Recommended for you" block on each visit.
  void landing.ensureLoaded()
})

async function onSelectTrack(trackId: string): Promise<void> {
  await trackActions.present(trackId as TrackId)
}

function onSelectCollection(id: string): void {
  void app.haptics.impact("light")
  void router.push({ name: "collection", params: { id } })
}

function openGroup(groupId: string): void {
  void router.push({ name: "collection-group", params: { groupId } })
}

function openAllCollections(): void {
  void router.push({ name: "collections" })
}
</script>

<template>
  <div class="landing">
    <!-- The whole landing loads as one batch behind `landing.ready`. Until it
         lands, a spinner rather than sections popping in one by one — the
         gate AppPage used to hold before this page dropped it for a docked
         search bar. -->
    <div v-if="!landing.ready" class="landing-loading">
      <IonSpinner name="dots" />
    </div>
    <template v-else>
      <div class="page-top" aria-hidden="true" />
      <template v-if="recommendedRows.length">
        <SectionHeader :title="$t('search.recommendedForYou')" />
        <TrackRowsList flush :rows="recommendedRows" @select="onSelectTrack" />
      </template>

      <CarouselSection
        v-for="g in topGroups"
        :key="g.id"
        :title="g.name"
        :items="g.collections"
        see-all
        :see-all-label="$t('search.collections.seeAllNamed', { name: g.name })"
        @select="onSelectCollection"
        @more="openGroup(g.id)"
      />

      <TileSection
        v-if="topicTiles.length"
        :title="$t('search.topicsSection')"
        :items="topicTiles"
        :min-tile="100"
        hashtag
        @select="onSelectTopic"
      />

      <template v-if="otherCollections.length">
        <SectionHeader
          :title="$t('search.collections.others')"
          see-all
          :see-all-label="
            $t('search.collections.seeAllNamed', { name: $t('search.collections.others') })
          "
          @more="openAllCollections"
        />
        <CollectionRows :items="otherCollections" @select="onSelectCollection" />
      </template>

      <div v-for="s in topicShelves" :key="s.topicId">
        <SectionHeader
          :title="s.name"
          hashtag
          see-all
          :see-all-label="$t('search.collections.seeAllNamed', { name: s.name })"
          @more="onSelectTopic(s.topicId)"
        />
        <TrackRowsList flush :rows="s.rows" @select="onSelectTrack" />
      </div>

      <MyLibraryShelf />

      <SmartLibraryEntry />

      <template v-if="previewLectures.length">
        <SectionHeader :title="$t('search.lecturesTitle')" />
        <TrackRowsList flush :rows="previewLectures" @select="onSelectTrack" />
      </template>
    </template>
  </div>
</template>

<style scoped>
.page-top {
  height: 8px;
}

.landing-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
}
</style>

<template>
  <AppPage :reserve-bottom-space="player.open" :loading="!landing.ready">
    <div class="page-top" aria-hidden="true" />
    <template v-if="recommendedRows.length">
      <SectionHeader :title="$t('search.recommendedForYou')" />
      <TracksList :rows="recommendedRows" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
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

    <LibraryBanner
      :title="$t('search.fullLibrary.title')"
      :description="
        $t('search.fullLibrary.subtitle', { count: landing.lectureCount }, landing.lectureCount)
      "
      background="/library/search-bg.webp"
      background-dark="/library/search-bg-dark.webp"
      @click="openTracks"
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
      <div class="flush-list">
        <template v-for="(c, index) in otherCollections" :key="c.id">
          <CollectionListItem
            :name="c.name"
            :cover-url="c.coverUrl"
            :description="c.description"
            @click="onSelectCollection(c.id)"
          />
          <RowDivider v-if="index < otherCollections.length - 1" />
        </template>
      </div>
    </template>

    <div v-for="s in topicShelves" :key="s.topicId">
      <SectionHeader
        :title="s.name"
        hashtag
        see-all
        :see-all-label="$t('search.collections.seeAllNamed', { name: s.name })"
        @more="onSelectTopic(s.topicId)"
      />
      <TracksList :rows="s.rows" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
    </div>

    <LibraryBanner
      :title="$t('search.smartLibrary.title')"
      :description="$t('search.smartLibrary.subtitle')"
      :pro-badge="!purchases.isSubscribed"
      :pro-badge-label="$t('app.proBadge')"
      background="/library/smart-bg.webp"
      background-dark="/library/smart-bg-dark.webp"
      @click="onSmartLibraryEntry"
    />

    <template v-if="previewLectures.length">
      <SectionHeader :title="$t('search.lecturesTitle')">
        <template #action>
          <IonButton class="no-ripple all-lectures" @click="openTracks">
            {{ $t("search.allLectures") }}
            <IconChevronRight :size="15" />
          </IonButton>
        </template>
      </SectionHeader>
      <TracksList :rows="previewLectures" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
    </template>

    <SmartLibraryDialog
      v-model:target-seconds="autoDownloadTargetSeconds"
      v-model:archive-delay="autoArchiveDelay"
      :open="smartLibraryDialogOpen"
      :filter-summary="smartLibrary.filterSummary.value"
      @update:open="smartLibraryDialogOpen = $event"
      @open-filters="smartLibraryFiltersOpen = true"
    />

    <SearchFiltersSheet
      v-model:filters="smartLibrary.filters.value"
      :open="smartLibraryFiltersOpen"
      :sections="smartLibrary.sections.value"
      :can-reset="smartLibrary.activeFilterCount.value > 0"
      @update:open="smartLibraryFiltersOpen = $event"
      @reset="smartLibrary.reset"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { IonButton, onIonViewWillEnter } from "@ionic/vue"
import { IconChevronRight } from "@tabler/icons-vue"
import { AppPage } from "@ui/primitives/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import {
  SectionHeader,
  CarouselSection,
  TileSection,
  CollectionListItem,
  LibraryBanner,
} from "@ui/features/collections/index.js"
import { SmartLibraryDialog } from "@ui/features/settings/index.js"
import { SearchFiltersSheet } from "@ui/features/tracks/search/filters/index.js"
import RowDivider from "@ui/components/RowDivider.vue"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useRecommendationsStore } from "@lectorium/stores/useRecommendationsStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useLibraryLandingStore } from "@lectorium/stores/useLibraryLandingStore.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import {
  AUTO_ARCHIVE_DELAY_KEY,
  type AutoArchiveDelay,
} from "@lectorium/composables/useAutoArchiveSweep.js"
import { useSmartLibraryBinding } from "@lectorium/views/Settings/composables/useSmartLibraryBinding.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import type { TrackId } from "@lib/domain/core.js"

const player = usePlayerStore()
const router = useRouter()
const app = useLectorium()
const appLanguage = useAppLanguage()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()
const recommendations = useRecommendationsStore()
const dictionaries = useDictionariesStore()
const purchases = usePurchasesStore()
const paywall = usePaywallStore()
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

// "Smart library" entry — same binding the Settings page drives, so editing it
// here and there reads/writes one persisted set. Gated behind the subscription:
// tapping while unsubscribed opens the paywall instead of the dialog.
const autoDownloadTargetSeconds = useConfig<number>("settings.autoDownloadTargetSeconds", 0)
const autoArchiveDelay = useConfig<AutoArchiveDelay>(AUTO_ARCHIVE_DELAY_KEY, "off")
const isSubscribed = computed(() => purchases.isSubscribed)
const smartLibrary = useSmartLibraryBinding(
  autoDownloadTargetSeconds,
  autoArchiveDelay,
  isSubscribed
)
const smartLibraryDialogOpen = ref(false)
const smartLibraryFiltersOpen = ref(false)
function onSmartLibraryEntry(): void {
  if (purchases.isSubscribed) smartLibraryDialogOpen.value = true
  else paywall.requestOpen("smartLibrary")
}

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
    rows: s.tracks.slice(0, SHELF_PREVIEW).map((tr) => mapper.toUiRow(tr)),
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
  // Ensure the batch is loaded (no-op once warmed at startup).
  void landing.ensureLoaded()
  // refresh (not ensureLoaded) so the profile reflects tracks heard since the
  // last visit — otherwise the shelves freeze on the first (often cold-start)
  // build until the app restarts.
  void recommendations.refresh()
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

function openTracks(): void {
  void router.push({ name: "tracks" })
}
</script>

<style scoped>
.page-top {
  height: 8px;
}

.all-lectures {
  /* Theme-aware warm surface pill (same token pair as .chip.off and the
     collection cards). Do NOT use --ion-color-step-*: the stepped scale
     inverts in dark theme and turned this into a bright cream blob. */
  --background: var(--ion-color-light);
  --background-activated: var(--ion-color-light-shade);
  --color: var(--ion-color-light-contrast);
  --box-shadow: none;
  --border-radius: 12px;
  --padding-top: 0;
  --padding-bottom: 0;
  --padding-start: 10px;
  --padding-end: 10px;
  height: 26px;
  min-height: 26px;
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0.01em;
}

.all-lectures :deep(svg) {
  margin-inline-start: 3px;
  margin-inline-end: -2px;
}

/* Every section's content sits the same 6px below its SectionHeader: the
   header owns the gap (its 6px bottom padding) and each content type's own
   intrinsic top is cancelled so nothing adds to it. */
:deep(ion-list) {
  --padding-top: 0;
  padding-top: 0;
  margin-top: -7px; /* cancel the first track row's 7px label margin */
}

.flush-list {
  margin-top: -8px; /* cancel the first collection row's 8px top padding */
}
</style>

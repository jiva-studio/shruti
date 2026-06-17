<template>
  <AppPage :reserve-bottom-space="player.open">
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
  type CarouselItem,
} from "@ui/features/collections/index.js"
import RowDivider from "@ui/components/RowDivider.vue"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useRecommendationsStore } from "@lectorium/stores/useRecommendationsStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import {
  useCollectionGroups,
  type GroupCollection,
} from "@lectorium/composables/useCollectionGroups.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { shuffled } from "@lectorium/utils/shuffle.js"
import { searchAndFilterTracks } from "@lib/application/searchAndFilterTracks.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const player = usePlayerStore()
const router = useRouter()
const app = useLectorium()
const appLanguage = useAppLanguage()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()
const recommendations = useRecommendationsStore()
const dictionaries = useDictionariesStore()
const { groups: collectionGroups, allCollections } = useCollectionGroups(appLanguage)

// "Recommended for you" picks + per-hot-topic shelves, derived on-device from
// the listening profile (see useRecommendationsStore). SHELF_PREVIEW caps the
// inline rows; "see all" opens the full topic-tracks view.
const recommendedRows = mapper.mapRows(() => recommendations.recommended, { context: "discovery" })

// Topics are shown two ways: a grid of tiles ("Темы") of any few topics, and —
// lower down — the user's three most-listened topics as title + lectures
// shelves. The grid skips the three shelf topics so nothing repeats.
const TOPIC_TILES = 6
const SHELF_PREVIEW = 3
const topicTiles = ref<CarouselItem[]>([])
function pickTopicTiles(): void {
  const inShelves = new Set(recommendations.shelves.map((s) => s.topicId))
  topicTiles.value = shuffled(dictionaries.topics.filter((t) => !inShelves.has(t.id)))
    .slice(0, TOPIC_TILES)
    .map((topic) => {
      const cover = dictionaries.topicCoverById.get(topic.id)
      return {
        id: topic.id,
        name: dictionaries.topicShortNamesById.get(topic.id) ?? topic.id,
        coverUrl: cover ? resolveAssetUrl(cover) : undefined,
      }
    })
}
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

const topGroups = computed(() => collectionGroups.value.slice(0, 2))
const OTHER_COLLECTIONS_LIMIT = 4
const PREVIEW_LECTURES_LIMIT = 10
const PREVIEW_POOL_SIZE = 40

const otherCollections = ref<readonly GroupCollection[]>([])
const lecturePool = ref<readonly Track[]>([])
const lectureSample = ref<readonly Track[]>([])

// mapRows keeps row state live and, in "discovery" context, folds playback
// progress to the binary state discovery surfaces use. The selection only
// changes on reshuffle, so the displayed set stays stable.
const previewLectures = mapper.mapRows(() => lectureSample.value, { context: "discovery" })

function pickOtherCollections(): void {
  const shown = new Set(topGroups.value.flatMap((g) => g.collections.map((c) => c.id)))
  otherCollections.value = shuffled(allCollections.value.filter((c) => !shown.has(c.id))).slice(
    0,
    OTHER_COLLECTIONS_LIMIT
  )
}

function pickLectures(): void {
  lectureSample.value = shuffled(lecturePool.value).slice(0, PREVIEW_LECTURES_LIMIT)
}

async function loadLecturePool(language: string): Promise<void> {
  try {
    lecturePool.value = await searchAndFilterTracks(
      { query: "", languageCodes: [language], limit: PREVIEW_POOL_SIZE, offset: 0 },
      { tracks: app.repositories().tracks }
    )
  } catch (err) {
    console.warn("[search] lecture preview load failed", err)
    lecturePool.value = []
  }
  pickLectures()
}

watch([collectionGroups, allCollections], pickOtherCollections, { immediate: true })
watch(appLanguage, (language) => void loadLecturePool(language), { immediate: true })
// Re-pick the random topic tiles once the vocabulary / shelves are loaded, and
// again on a language switch so the tile labels follow the new locale.
watch(
  () => [dictionaries.topics.length, recommendations.shelves.length, appLanguage.value] as const,
  pickTopicTiles,
  { immediate: true }
)

onIonViewWillEnter(() => {
  pickOtherCollections()
  pickLectures()
  pickTopicTiles()
  void dictionaries.ensureLoaded()
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

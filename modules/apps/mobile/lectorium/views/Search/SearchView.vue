<template>
  <AppPage :reserve-bottom-space="player.open">
    <template v-if="recommendedRows.length">
      <IonListHeader>
        <IonLabel>{{ $t("search.recommendedForYou") }}</IonLabel>
      </IonListHeader>
      <TracksList :rows="recommendedRows" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
    </template>

    <div v-for="g in topGroups" :key="g.id" class="collection-group">
      <IonListHeader>
        <IonLabel>{{ g.name }}</IonLabel>
        <IonButton
          class="no-ripple"
          :aria-label="$t('search.collections.seeAllNamed', { name: g.name })"
          @click="openGroup(g.id)"
        >
          <IconChevronRight :size="20" />
        </IonButton>
      </IonListHeader>
      <CollectionsCarousel :items="g.collections" @select="onSelectCollection" />
    </div>

    <template v-if="otherCollections.length">
      <IonListHeader>
        <IonLabel>{{ $t("search.collections.others") }}</IonLabel>
        <IonButton
          class="no-ripple"
          :aria-label="
            $t('search.collections.seeAllNamed', { name: $t('search.collections.others') })
          "
          @click="openAllCollections"
        >
          <IconChevronRight :size="20" />
        </IonButton>
      </IonListHeader>
      <CollectionListItem
        v-for="c in otherCollections"
        :key="c.id"
        :name="c.name"
        :cover-url="c.coverUrl"
        :description="c.description"
        @click="onSelectCollection(c.id)"
      />
    </template>

    <div v-for="s in topicShelves" :key="s.topicId" class="collection-group">
      <IonListHeader>
        <IonLabel>{{ s.title }}</IonLabel>
        <IonButton
          class="no-ripple"
          :aria-label="$t('search.collections.seeAllNamed', { name: s.name })"
          @click="openTopic(s.topicId)"
        >
          <IconChevronRight :size="20" />
        </IonButton>
      </IonListHeader>
      <TracksList :rows="s.rows" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
    </div>

    <template v-if="previewLectures.length">
      <IonListHeader>
        <IonLabel>{{ $t("search.lecturesTitle") }}</IonLabel>
        <IonButton
          class="no-ripple"
          :aria-label="$t('search.collections.seeAllNamed', { name: $t('search.lecturesTitle') })"
          @click="openTracks"
        >
          <IconChevronRight :size="20" />
        </IonButton>
      </IonListHeader>
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
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import { IonButton, IonLabel, IonListHeader, onIonViewWillEnter } from "@ionic/vue"
import { IconChevronRight } from "@tabler/icons-vue"
import { AppPage } from "@ui/primitives/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { CollectionsCarousel, CollectionListItem } from "@ui/features/collections/index.js"
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
import { searchAndFilterTracks } from "@lib/application/searchAndFilterTracks.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const player = usePlayerStore()
const router = useRouter()
const app = useLectorium()
const { t } = useI18n()
const appLanguage = useAppLanguage()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()
const recommendations = useRecommendationsStore()
const dictionaries = useDictionariesStore()
const { groups: collectionGroups, allCollections } = useCollectionGroups(appLanguage)

// "Recommended for you" picks + per-hot-topic shelves, derived on-device from
// the listening profile (see useRecommendationsStore). SHELF_PREVIEW caps the
// inline rows; "see all" opens the full topic-tracks view.
const SHELF_PREVIEW = 4
const recommendedRows = mapper.mapRows(() => recommendations.recommended, { context: "discovery" })
const topicShelves = computed(() =>
  recommendations.shelves.map((s) => {
    const name = dictionaries.topicNamesById.get(s.topicId) ?? s.topicId
    return {
      topicId: s.topicId,
      name,
      title: recommendations.hasHistory
        ? t("search.becauseListenedAbout", { topic: name })
        : name,
      rows: s.tracks.slice(0, SHELF_PREVIEW).map((tr) => mapper.toUiRow(tr)),
    }
  })
)

function openTopic(topicId: string): void {
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

function shuffled<T>(items: readonly T[]): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool
}

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

onIonViewWillEnter(() => {
  pickOtherCollections()
  pickLectures()
  void dictionaries.ensureLoaded()
  void recommendations.ensureLoaded()
})

async function onSelectTrack(trackId: string): Promise<void> {
  await trackActions.present(trackId as TrackId)
}

function onSelectCollection(id: string): void {
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
ion-list-header ion-label {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--ion-text-color);
}

ion-list-header ion-button {
  --color: var(--ion-color-medium);
}

:deep(ion-list) {
  --padding-top: 0;
  padding-top: 0;
}
</style>

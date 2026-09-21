<script setup lang="ts">
import { computed, ref } from "vue"
import { onIonViewDidLeave, onIonViewWillEnter } from "@ionic/vue"
import {
  IonText,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { AppPage } from "@ui/primitives/index.js"
import { ActivitySummary } from "@ui/features/activity/index.js"
import { useI18n } from "vue-i18n"
import { PlaylistSection, PlaylistStarterPacks } from "@ui/features/playlist/index.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useCollectionLanguage } from "@lectorium/composables/useCollectionLanguage.js"
import { usePlaybackRowProgress } from "@lectorium/composables/usePlaybackRowProgress.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useDurationFormatter } from "@lectorium/composables/useDurationFormatter.js"
import { useCollections } from "@lectorium/composables/useCollections.js"
import { useToast } from "@kit/composables"
import { addTracksToPlaylist } from "@usecases"
import { useHomeController } from "./HomeView.controller.js"
import { usePlaylistGroups } from "./usePlaylistGroups.js"
import HomeNags from "./components/HomeNags.vue"
import PlaylistQueueHeader from "./components/PlaylistQueueHeader.vue"

const { t } = useI18n()
const showActivityTracker = useConfig<boolean>("settings.showActivityTracker", true)
const formatDuration = useDurationFormatter()

const emptyImage = "/playlist-empty.png"

const player = usePlayerStore()
const {
  onScreen,
  rows,
  isLoading,
  error,
  hasMore,
  queueCount,
  queueTotalSeconds,
  heatmapDays,
  currentStreak,
  completedCount,
  totalListenedSeconds,
  reloadHeatmap,
  loadMore,
  onSelect,
  onRemove,
} = useHomeController()

// Shown whenever there is anything to chart — a queue, or a record from
// earlier sessions. Hiding it only for a brand-new user keeps the screen
// useful once auto-archive has run the queue dry.
const hasAnyActivity = computed(
  () => completedCount.value > 0 || totalListenedSeconds.value > 0 || currentStreak.value > 0
)
const showActivity = computed(
  () => showActivityTracker.value && (rows.value.length > 0 || hasAnyActivity.value)
)

// Ionic hides but never unmounts a tab page, so `onScreen` gates the live
// playback overlay: off the tab it stops reading the position at all.
const playback = usePlaybackRowProgress(onScreen)

onIonViewWillEnter(() => {
  onScreen.value = true
  void reloadHeatmap()
})

onIonViewDidLeave(() => {
  onScreen.value = false
})

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await loadMore()
  await e.target.complete()
}

// Empty-state suggestions. The composable returns [] on a bundled current.db
// that predates the schema, degrading to the pre-feature empty state.
const playlist = usePlaylistStore()
// Collections (featured cards + playlist-group labels) follow the chosen
// library content language, not the UI locale.
const collectionLanguage = useCollectionLanguage()
// Derive collection groups (accordions) from the flat playlist rows.
const { items: playlistItems } = usePlaylistGroups(rows, collectionLanguage)
const toast = useToast()
const { collections: featuredCollections } = useCollections(collectionLanguage)
const addingCollection = ref(false)

const emptyMessage = computed(() =>
  featuredCollections.value.length > 0
    ? t("home.tapToAddTracksWithPacks")
    : t("home.tapToAddTracks")
)

async function onPickCollection(collectionId: string): Promise<void> {
  const collection = featuredCollections.value.find((p) => p.id === collectionId)
  if (!collection || collection.trackIds.length === 0) return
  addingCollection.value = true
  try {
    const result = await addTracksToPlaylist(
      { trackIds: [...collection.trackIds] },
      { playlist: { add: (id) => playlist.add(id, collectionId) } }
    )
    if (!result.ok) {
      void toast.error(t("home.starterPacks.error"))
    }
  } catch {
    void toast.error(t("home.starterPacks.error"))
  } finally {
    addingCollection.value = false
  }
}
</script>

<template>
  <AppPage :loading="isLoading && rows.length === 0" :reserve-bottom-space="player.open">
    <IonText v-if="error" color="danger" class="ion-padding">
      <p>{{ error }}</p>
    </IonText>
    <template v-else>
      <HomeNags :has-tracks="rows.length > 0" :on-screen="onScreen" />
      <ActivitySummary
        v-if="showActivity"
        :title="$t('activity.title')"
        :streak="currentStreak"
        :streak-label="$t('activity.streak')"
        :completed="completedCount"
        :completed-label="$t('activity.completedLectures')"
        :total-listened-text="totalListenedSeconds > 0 ? formatDuration(totalListenedSeconds) : ''"
        :total-listened-label="$t('activity.totalListened')"
        :days="heatmapDays"
      />
      <PlaylistSection
        :items="playlistItems"
        :playback="playback"
        :empty-header="$t('home.playlistIsEmpty')"
        :empty-message="emptyMessage"
        :empty-image="emptyImage"
        @click="onSelect"
        @delete="onRemove"
      >
        <template #header>
          <PlaylistQueueHeader :count="queueCount" :total-seconds="queueTotalSeconds" />
        </template>
        <template #empty-footer>
          <PlaylistStarterPacks
            :packs="featuredCollections"
            :disabled="addingCollection"
            @pick="onPickCollection"
          />
        </template>
      </PlaylistSection>
    </template>
    <IonInfiniteScroll :disabled="!hasMore" @ion-infinite="onInfinite">
      <IonInfiniteScrollContent />
    </IonInfiniteScroll>
  </AppPage>
</template>

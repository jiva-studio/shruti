<template>
  <AppPage :loading="isLoading && rows.length === 0" :reserve-player-space="player.open">
    <IonText v-if="error" color="danger" class="ion-padding">
      <p>{{ error }}</p>
    </IonText>
    <template v-else>
      <template v-if="showActivity">
        <SectionHeader :title="$t('activity.title')">
          <StreakBadge :value="currentStreak" />
          <CompletedBadge :value="completedCount" />
          <DurationBadge
            v-if="totalListenedSeconds > 0"
            :text="formatDuration(totalListenedSeconds)"
            :title="$t('activity.totalListened')"
          />
        </SectionHeader>
        <ActivitySection :days="heatmapDays" />
      </template>
      <PlaylistSection
        :rows="rows"
        :empty-header="$t('home.playlistIsEmpty')"
        :empty-message="$t('home.tapToAddTracks')"
        :empty-image="emptyImage"
        @click="onSelect"
        @delete="onRemove"
      >
        <template #header>
          <SectionHeader :title="$t('home.upNext')">
            <PlaylistCountBadge :value="queueCount" />
            <DurationBadge v-if="queueTotalSeconds > 0" :text="formatDuration(queueTotalSeconds)" />
          </SectionHeader>
        </template>
      </PlaylistSection>
    </template>
    <IonInfiniteScroll :disabled="!hasMore" @ion-infinite="onInfinite">
      <IonInfiniteScrollContent />
    </IonInfiniteScroll>
  </AppPage>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { onIonViewWillEnter } from "@ionic/vue"
import {
  IonText,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { AppPage, SectionHeader } from "@ui/primitives/index.js"
import { DurationBadge } from "@ui/components/badges/index.js"
import { ActivitySection, CompletedBadge, StreakBadge } from "@ui/features/activity/index.js"
import { PlaylistCountBadge, PlaylistSection } from "@ui/features/playlist/index.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useDurationFormatter } from "@lectorium/composables/useDurationFormatter.js"
import { useHomeController } from "./HomeView.controller.js"

const showActivityTracker = useConfig<boolean>("settings.showActivityTracker", true)
const formatDuration = useDurationFormatter()

const emptyImage = "/playlist-empty.png"

const player = usePlayerStore()
const {
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

// Show the activity widget whenever the user has anything to chart —
// either a non-empty current playlist OR a track-record from previous
// sessions (any completed track or any listened time). Hiding it only
// when the user is brand-new keeps the home screen useful after
// auto-archive runs the queue dry: the heatmap above + "playlist is
// empty, tap to add" below reads as "your progress is intact, just
// pick the next thing", rather than the dead full-screen empty state
// the user used to land on.
const hasAnyActivity = computed(
  () => completedCount.value > 0 || totalListenedSeconds.value > 0 || currentStreak.value > 0
)
const showActivity = computed(
  () => showActivityTracker.value && (rows.value.length > 0 || hasAnyActivity.value)
)

onIonViewWillEnter(() => {
  void reloadHeatmap()
})

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await loadMore()
  await e.target.complete()
}
</script>

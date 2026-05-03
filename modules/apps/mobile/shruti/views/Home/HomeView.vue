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
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useDurationFormatter } from "@shruti/composables/useDurationFormatter.js"
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

// Hide the activity widget while the playlist is empty: a brand-new
// user has nothing to chart yet, and an empty heatmap reads as a wall
// of skipped days. The block reappears once the user has at least one
// queued lecture.
const showActivity = computed(() => showActivityTracker.value && rows.value.length > 0)

onIonViewWillEnter(() => {
  void reloadHeatmap()
})

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await loadMore()
  await e.target.complete()
}
</script>

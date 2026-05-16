<template>
  <AppPage :loading="isLoading && rows.length === 0" :reserve-player-space="player.open">
    <IonText v-if="error" color="danger" class="ion-padding">
      <p>{{ error }}</p>
    </IonText>
    <template v-else>
      <SubscriptionNagBanner
        v-if="showSubscriptionNag"
        @open="subscriptionDialogOpen = true"
        @dismiss="onDismissSubscriptionNag"
      />
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
    <SubscriptionDialog
      v-model:open="subscriptionDialogOpen"
      :packages="subscription.packages"
      :is-subscribed="subscription.isSubscribed"
      :purchasing="subscription.purchasing"
      :restoring="subscription.restoring"
      :legal-documents="subscription.legalDocuments"
      @subscribe="subscription.onSubscribe"
      @restore="subscription.onRestore"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
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
import {
  PlaylistCountBadge,
  PlaylistSection,
  SubscriptionNagBanner,
} from "@ui/features/playlist/index.js"
import { SubscriptionDialog } from "@ui/features/settings/index.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useDurationFormatter } from "@shruti/composables/useDurationFormatter.js"
import { useSubscriptionBinding } from "@shruti/views/Settings/composables/useSubscriptionBinding.js"
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

// Soft donation-style nag for non-subscribers. Cooldown is 14 days
// from the last dismiss; without a stored timestamp we show it on
// first eligible render. The banner only renders when RevenueCat is
// available — on builds with empty IAP keys the subscription UI is
// hidden everywhere.
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
const subscription = useSubscriptionBinding()
const subscriptionNagDismissedAt = useConfig<number | null>(
  "home.subscriptionNag.dismissedAt",
  null
)
const subscriptionDialogOpen = ref(false)
const showSubscriptionNag = computed(() => {
  if (!subscription.available || subscription.isSubscribed) return false
  const ts = subscriptionNagDismissedAt.value
  if (!ts) return true
  return Date.now() - ts >= FOURTEEN_DAYS_MS
})
function onDismissSubscriptionNag(): void {
  subscriptionNagDismissedAt.value = Date.now()
}

onIonViewWillEnter(() => {
  void reloadHeatmap()
})

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await loadMore()
  await e.target.complete()
}
</script>

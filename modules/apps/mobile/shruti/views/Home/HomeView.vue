<template>
  <AppPage :loading="isLoading && rows.length === 0" :reserve-bottom-space="player.open">
    <IonText v-if="error" color="danger" class="ion-padding">
      <p>{{ error }}</p>
    </IonText>
    <template v-else>
      <SubscriptionNagBanner
        v-if="showSubscriptionNag"
        @open="paywall.requestOpen()"
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
        :empty-message="emptyMessage"
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
        <template #empty-footer>
          <PlaylistStarterPacks :packs="starterPacks" :disabled="addingPack" @pick="onPickPack" />
        </template>
      </PlaylistSection>
    </template>
    <IonInfiniteScroll :disabled="!hasMore" @ion-infinite="onInfinite">
      <IonInfiniteScrollContent />
    </IonInfiniteScroll>
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
import { useI18n } from "vue-i18n"
import {
  PlaylistCountBadge,
  PlaylistSection,
  PlaylistStarterPacks,
  SubscriptionNagBanner,
} from "@ui/features/playlist/index.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useDurationFormatter } from "@shruti/composables/useDurationFormatter.js"
import { useStarterPacks } from "@shruti/composables/useStarterPacks.js"
import { useSubscriptionBinding } from "@shruti/views/Settings/composables/useSubscriptionBinding.js"
import { useToast } from "@shruti/services/useToast.js"
import { addTracksToPlaylist } from "@lib/application"
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
//
// Wait for `subscription.ready && !subscription.reconciling` so we don't
// render the nag before the *final* subscribed answer is in: `ready`
// flips after the first anonymous getCustomerState(), but an
// account-tied subscription only surfaces once the post-sign-in RC
// logIn lands a beat later — gating on `ready` alone still flashes the
// banner for subscribed users, then hides it once entitlements arrive.
//
// We also hold the nag for the first week after install: asking for
// money before the user has had a chance to get value from the app is
// the wrong first impression. Install age comes from the shared
// `proactive.firstSeenAtMs` stamp; until it's known we stay quiet.
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
const NAG_GRACE_MS = 7 * 24 * 60 * 60 * 1000
const paywall = usePaywallStore()
const subscription = useSubscriptionBinding()
const firstSeenAt = useConfig<number | null>("proactive.firstSeenAtMs", null)
const subscriptionNagDismissedAt = useConfig<number | null>(
  "home.subscriptionNag.dismissedAt",
  null
)
const showSubscriptionNag = computed(() => {
  if (!subscription.ready || subscription.reconciling) return false
  if (!subscription.available || subscription.isSubscribed) return false
  const installedAt = firstSeenAt.value
  if (installedAt === null || Date.now() - installedAt < NAG_GRACE_MS) return false
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

// Empty-state starter packs: chip set + tap → batch playlist.add.
// Sourced from the catalog DB (packs / pack_tracks); the composable
// returns [] when the bundled current.db predates the schema, so the
// empty-state degrades to the pre-feature look on older builds.
const { t } = useI18n()
const playlist = usePlaylistStore()
const appLanguage = useAppLanguage()
const toast = useToast()
const { packs: starterPacks } = useStarterPacks(appLanguage)
const addingPack = ref(false)

// Append the "or pick from the suggestions below" call-to-action only
// when at least one starter pack made it out of the catalog DB — keeps
// the original message intact on old bundled DBs that predate the
// `packs` schema.
const emptyMessage = computed(() =>
  starterPacks.value.length > 0 ? t("home.tapToAddTracksWithPacks") : t("home.tapToAddTracks")
)

async function onPickPack(packId: string): Promise<void> {
  const pack = starterPacks.value.find((p) => p.id === packId)
  if (!pack || pack.trackIds.length === 0) return
  addingPack.value = true
  try {
    const result = await addTracksToPlaylist(
      { trackIds: [...pack.trackIds] },
      { playlist: { add: (id) => playlist.add(id) } }
    )
    if (!result.ok) {
      void toast.error(t("home.starterPacks.error"))
    }
  } catch {
    void toast.error(t("home.starterPacks.error"))
  } finally {
    addingPack.value = false
  }
}
</script>

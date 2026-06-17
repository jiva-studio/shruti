<template>
  <AppPage :loading="isLoading && rows.length === 0" :reserve-bottom-space="player.open">
    <IonText v-if="error" color="danger" class="ion-padding">
      <p>{{ error }}</p>
    </IonText>
    <template v-else>
      <!-- At most ONE nag banner at a time. Both use the same presentational
           NagBanner; this view decides which to show and with what copy. The
           notifications nag takes precedence over the subscription nag
           (showSubscriptionNag gates on !showNotificationsNag) so we never
           stack two asks at the top of the home screen. -->
      <NagBanner
        v-if="showNotificationsNag"
        variant="success"
        :title="$t('home.notificationsNag.title')"
        :description="$t('home.notificationsNag.description')"
        :dismiss-label="$t('home.notificationsNag.dismiss')"
        @action="onEnableNotifications"
        @dismiss="onDismissNotificationsNag"
      />
      <NagBanner
        v-if="showSubscriptionNag"
        variant="success"
        :title="$t('home.subscriptionNag.title')"
        :description="$t('home.subscriptionNag.description')"
        :dismiss-label="$t('home.subscriptionNag.dismiss')"
        @action="paywall.requestOpen()"
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
        :items="playlistItems"
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
  NagBanner,
  PlaylistCountBadge,
  PlaylistSection,
  PlaylistStarterPacks,
} from "@ui/features/playlist/index.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useDurationFormatter } from "@shruti/composables/useDurationFormatter.js"
import { useCollections } from "@shruti/composables/useCollections.js"
import { useSubscriptionBinding } from "@shruti/views/Settings/composables/useSubscriptionBinding.js"
import { useShruti } from "@shruti/shruti.js"
import { useToast } from "@kit/composables"
import { addTracksToPlaylist } from "@usecases"
import { useHomeController } from "./HomeView.controller.js"
import { usePlaylistGroups } from "./usePlaylistGroups.js"

const { t } = useI18n()
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
// Notifications nag. The whole proactive-push subsystem (holidays,
// weekly digest, inactivity re-engagement, "finish your lecture") is
// dead in the water on Android 13+ until the OS grants POST_NOTIFICATIONS
// at runtime — and the only place that ever requested it was the Settings
// daily-reminder toggle. So a user who never opened Settings got nothing.
// This banner is the missing entry point: it's shown when permission is
// not granted, and tapping it requests permission so the proactive pushes
// can finally surface. Requesting permission is the whole job — we don't
// silently arm the daily reminder here; that stays its own opt-in in
// Settings. It takes precedence over the subscription nag (engagement before
// monetization) and re-appears 14 days after a dismiss, mirroring the
// subscription cooldown.
//
// The trigger is "the user has added lectures" — we never nag on an empty
// playlist. Adding tracks is the moment notifications start paying off
// (queue progress, finish-your-lecture, etc.), and a permission ask before
// the user has any content is the wrong first impression. Once there's
// something in the queue we ask; if ignored, the 14-day cooldown brings the
// banner back periodically.
const app = useShruti()
const notificationsNagDismissedAt = useConfig<number | null>(
  "home.notificationsNag.dismissedAt",
  null
)
// Optimistic `true` so the banner never flashes before the async
// permission check resolves; flipped to the real value on mount / resume.
const notificationsGranted = ref(true)
const showNotificationsNag = computed(() => {
  if (notificationsGranted.value) return false
  // Trigger: the user has added lectures. Stay silent on an empty playlist.
  if (rows.value.length === 0) return false
  const ts = notificationsNagDismissedAt.value
  if (!ts) return true
  return Date.now() - ts >= FOURTEEN_DAYS_MS
})
async function refreshNotificationPermission(): Promise<void> {
  const p = await app.notifications.checkPermission().catch(() => "unknown" as const)
  notificationsGranted.value = p === "granted"
}
async function onEnableNotifications(): Promise<void> {
  // Stamp `dismissedAt` regardless of the outcome so a denied prompt
  // doesn't leave the banner stuck on screen forever (it'll come back in
  // 14 days like any other dismiss). The request is the point: granting
  // POST_NOTIFICATIONS unblocks every proactive push.
  notificationsNagDismissedAt.value = Date.now()
  try {
    await app.notifications.requestPermission()
  } catch (err) {
    console.warn("[home] notification permission request failed", err)
  }
  await refreshNotificationPermission()
}
function onDismissNotificationsNag(): void {
  notificationsNagDismissedAt.value = Date.now()
}

const showSubscriptionNag = computed(() => {
  // The notifications nag wins the single banner slot — don't stack.
  if (showNotificationsNag.value) return false
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
  void refreshNotificationPermission()
})

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  await loadMore()
  await e.target.complete()
}

// Empty-state suggestions: featured-collection chips + tap → batch
// playlist.add. The composable returns [] when the bundled current.db
// predates the schema, so the empty-state degrades to the pre-feature look
// on older builds.
const playlist = usePlaylistStore()
const appLanguage = useAppLanguage()
// Derive collection groups (accordions) from the flat playlist rows.
const { items: playlistItems } = usePlaylistGroups(rows, appLanguage)
const toast = useToast()
const { collections: featuredCollections } = useCollections(appLanguage)
const addingCollection = ref(false)

// Append the "or pick from the suggestions below" call-to-action only when
// at least one featured collection made it out of the catalog DB — keeps the
// original message intact on old bundled DBs that predate the schema.
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

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { NagBanner } from "@ui/features/playlist/index.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { useSubscriptionBinding } from "@lectorium/views/Settings/composables/useSubscriptionBinding.js"
import { isNagDue, isPastGrace } from "../nagCooldown.js"

// At most one ask at the top of the home screen: notifications win the slot,
// because engagement comes before monetization.
const props = defineProps<{ hasTracks: boolean; onScreen: boolean }>()

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
const NAG_GRACE_MS = 7 * 24 * 60 * 60 * 1000

const app = useLectorium()
const paywall = usePaywallStore()
const subscription = useSubscriptionBinding()
const firstSeenAt = useConfig<number | null>("proactive.firstSeenAtMs", null)
const subscriptionNagDismissedAt = useConfig<number | null>(
  "home.subscriptionNag.dismissedAt",
  null
)
const notificationsNagDismissedAt = useConfig<number | null>(
  "home.notificationsNag.dismissedAt",
  null
)

// Optimistic `true` so the banner never flashes before the async permission
// check resolves; flipped to the real value on entry.
const notificationsGranted = ref(true)

// The whole proactive-push subsystem is dead on Android 13+ until
// POST_NOTIFICATIONS is granted at runtime, and this is the entry point that
// asks for it. Only once the user has queued lectures — a permission ask
// before there is any content is the wrong first impression.
const showNotificationsNag = computed(() => {
  if (notificationsGranted.value || !props.hasTracks) return false
  return isNagDue(notificationsNagDismissedAt.value, Date.now(), FOURTEEN_DAYS_MS)
})

// `subscription.resolved` rather than `ready`: an account-tied subscription
// only surfaces after the post-sign-in RevenueCat logIn, and gating earlier
// flashes the banner at subscribers.
const showSubscriptionNag = computed(() => {
  if (showNotificationsNag.value) return false
  if (!subscription.resolved) return false
  if (!subscription.available || subscription.isSubscribed) return false
  if (!isPastGrace(firstSeenAt.value, Date.now(), NAG_GRACE_MS)) return false
  return isNagDue(subscriptionNagDismissedAt.value, Date.now(), FOURTEEN_DAYS_MS)
})

async function refreshNotificationPermission(): Promise<void> {
  const p = await app.notifications.checkPermission().catch(() => "unknown" as const)
  notificationsGranted.value = p === "granted"
}

// Stamped regardless of the outcome, so a denied prompt doesn't leave the
// banner on screen until the next cooldown.
async function onEnableNotifications(): Promise<void> {
  notificationsNagDismissedAt.value = Date.now()
  try {
    await app.notifications.requestPermission()
  } catch (err) {
    console.warn("[home] notification permission request failed", err)
  }
  await refreshNotificationPermission()
}

// Re-read on every entry: the user may have granted it in system settings.
watch(
  () => props.onScreen,
  (on) => {
    if (on) void refreshNotificationPermission()
  },
  { immediate: true }
)
</script>

<template>
  <NagBanner
    v-if="showNotificationsNag"
    variant="success"
    :title="$t('home.notificationsNag.title')"
    :description="$t('home.notificationsNag.description')"
    :dismiss-label="$t('home.notificationsNag.dismiss')"
    @action="onEnableNotifications"
    @dismiss="notificationsNagDismissedAt = Date.now()"
  />
  <NagBanner
    v-if="showSubscriptionNag"
    variant="success"
    :title="$t('home.subscriptionNag.title')"
    :description="$t('home.subscriptionNag.description')"
    :dismiss-label="$t('home.subscriptionNag.dismiss')"
    @action="paywall.requestOpen()"
    @dismiss="subscriptionNagDismissedAt = Date.now()"
  />
</template>

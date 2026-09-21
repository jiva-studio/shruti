<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { BuildInfoId } from "@kit/ui"
import { AppPage, BuildInfo } from "@ui/primitives/index.js"
import {
  SettingsAccountGroup,
  SettingsAppearanceGroup,
  SettingsChatGroup,
  SettingsDataGroup,
  SettingsLibraryGroup,
  TrackInfoDialog,
} from "@ui/features/settings/index.js"
import type { SubscriptionFeatureKey } from "@ui/features/subscription/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { signOutNoticeKeys } from "@lectorium/services/signOutNotice.js"
import { DOWNLOAD_LIMIT_PRESETS } from "@lectorium/stores/useDownloadQuotaStore.js"
import { TEXT_SCALE_PRESETS } from "@lectorium/composables/useTextScale.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { useAnonymousSignInFlow } from "@lectorium/composables/useAnonymousSignInFlow.js"
import { useDebugUnlockTrigger } from "@lectorium/composables/useDebugUnlockTrigger.js"
import { useToast } from "@kit/composables"
import { AccountDeleteError } from "@ports/app/auth.js"
import { useSettingsController } from "./SettingsView.controller.js"
import SettingsSupportSection from "./components/SettingsSupportSection.vue"
import SettingsSmartLibrarySection from "./components/SettingsSmartLibrarySection.vue"

const player = usePlayerStore()
const paywall = usePaywallStore()
const auth = useAuthStore()
const lectorium = useLectorium()
const { t } = useI18n()
const toast = useToast()
const {
  version,
  buildId,
  dbScheme,
  dbNumber,
  appLanguage,
  chatLanguage,
  chatTranslateCitations,
  syncChats,
  trackMetaConfig,
  showPlayerProgress,
  textScale,
  showPlayerOnNotes,
  showActivityTracker,
  autoArchiveDelay,
  autoArchiveLastDelay,
  highlightCurrentSentence,
  autoScroll,
  autoPlayNext,
  openTranscriptAutomatically,
  notificationsEnabled,
  notificationsTime,
  autoDownloadTargetSeconds,
  downloadLimitBytes,
  downloadUsedBytes,
  smartLibrary,
  libraryLanguages,
  contentLanguageItems,
  setLibraryLanguages,
  activeServerId,
  serverItems,
  languageItems,
  onClearCache,
  onExportDatabase,
  onImportFileSelected,
  subscription,
} = useSettingsController()

const debugTrigger = useDebugUnlockTrigger()
const debugUnlocked = debugTrigger.unlocked

// Surfaced in the build footer once the hidden debug menu is unlocked.
const buildInfoDebugIds = computed<BuildInfoId[]>(() => {
  if (!debugUnlocked.value) return []
  const ids: BuildInfoId[] = []
  if (auth.userId) ids.push({ label: "uid", value: auth.userId })
  if (subscription.appUserId) ids.push({ label: "rc", value: subscription.appUserId })
  return ids
})
const { triggerSignIn } = useAnonymousSignInFlow()

const trackInfoOpen = ref(false)

// Signing out wipes this device's copy of the account's data without asking,
// so the toast says where the data went — and only what is true of this
// sign-out. Skipped when nothing was wiped: an anonymous session keeps its
// rows, there being nowhere to restore them from.
async function onSignOut(): Promise<void> {
  const outcome = await auth.signOut()
  if (!outcome.wiped) return
  const notice = signOutNoticeKeys(outcome)
    .map((key) => t(key))
    .join(" ")
  await toast.info(notice)
}

async function onDeleteAccountConfirm(opts: { wipeLocal: boolean }): Promise<void> {
  // The sheet that produced this emit has already dismissed itself; on
  // failure the user is still signed in with local data intact.
  try {
    await auth.deleteAccount(opts)
  } catch (e) {
    console.warn("[settings] delete account failed:", e)
    let key = "settings.account.deleteAccount.errorToast"
    if (e instanceof AccountDeleteError) {
      switch (e.kind) {
        case "already-deleted":
          key = "settings.account.deleteAccount.alreadyDeletedToast"
          break
        case "rate-limited":
          key = "settings.account.deleteAccount.rateLimitedToast"
          break
        case "network":
          key = "settings.account.deleteAccount.networkErrorToast"
          break
        case "server":
          key = "settings.account.deleteAccount.serverErrorToast"
          break
        // "unauthorized" and "unknown" fall through to the generic toast
      }
    }
    await toast.error(t(key))
    return
  }
}

// The failover client reads `activeServer.value.id` at every call and
// `initLectorium` persists it; connectivity is all the picker controls.
function onPreferredServerChange(newServerId: string): void {
  if (newServerId === lectorium.activeServer.value.id) return
  lectorium.setActiveServerById(newServerId)
}

// `isSubscribed` reads false for the length of the post-sign-in RevenueCat
// logIn, so `ensurePro` waits the answer out rather than sending a subscriber
// to a purchase screen or leaving the control dead.
function onRequestPaywall(feature?: SubscriptionFeatureKey): void {
  void subscription.ensurePro(feature)
}
</script>

<template>
  <AppPage :reserve-bottom-space="player.open">
    <SettingsAccountGroup
      :active-server-id="activeServerId"
      :anonymous="auth.anonymous"
      :email="auth.email"
      :name="auth.name"
      :picture="auth.picture"
      :is-subscribed="subscription.isSubscribed"
      :subscription-resolved="subscription.resolved"
      :server-items="serverItems"
      @sign-in-anonymous="triggerSignIn"
      @sign-out="onSignOut"
      @open-paywall="paywall.requestOpen()"
      @manage-subscription="paywall.requestOpen()"
      @delete-account="onDeleteAccountConfirm"
      @preferred-server-change="onPreferredServerChange"
    />

    <SettingsLibraryGroup
      v-model:download-limit-bytes="downloadLimitBytes"
      :language-items="contentLanguageItems"
      :selected="libraryLanguages"
      :download-limit-presets="DOWNLOAD_LIMIT_PRESETS"
      :download-used-bytes="downloadUsedBytes"
      @update:selected="setLibraryLanguages"
    />

    <SettingsAppearanceGroup
      v-model:app-language="appLanguage"
      v-model:show-player-progress="showPlayerProgress"
      v-model:text-scale="textScale"
      v-model:show-player-on-notes="showPlayerOnNotes"
      v-model:highlight-current-sentence="highlightCurrentSentence"
      v-model:auto-scroll="autoScroll"
      v-model:auto-play-next="autoPlayNext"
      v-model:open-transcript-automatically="openTranscriptAutomatically"
      :language-items="languageItems"
      :text-scale-presets="TEXT_SCALE_PRESETS"
      :is-subscribed="subscription.isSubscribed"
      @request-paywall="onRequestPaywall($event)"
      @open-track-info="trackInfoOpen = true"
    />

    <SettingsChatGroup
      v-model:chat-language="chatLanguage"
      v-model:chat-translate-citations="chatTranslateCitations"
      v-model:sync-chats="syncChats"
      :language-items="languageItems"
    />

    <TrackInfoDialog
      v-model:config="trackMetaConfig"
      :open="trackInfoOpen"
      @update:open="trackInfoOpen = $event"
    />

    <SettingsSmartLibrarySection
      v-model:filters="smartLibrary.filters.value"
      v-model:show-activity-tracker="showActivityTracker"
      v-model:notifications-enabled="notificationsEnabled"
      v-model:notifications-time="notificationsTime"
      v-model:target-seconds="autoDownloadTargetSeconds"
      v-model:archive-delay="autoArchiveDelay"
      v-model:last-archive-delay="autoArchiveLastDelay"
      :smart-library="smartLibrary"
      :subscription="subscription"
    />

    <SettingsDataGroup @export="onExportDatabase" @import-file="onImportFileSelected" />

    <SettingsSupportSection
      :version="version"
      :build-id="buildId"
      :debug-unlocked="debugUnlocked"
      @clear-cache="onClearCache"
    />

    <BuildInfo
      :version="version"
      :build-id="buildId"
      :db-number="dbNumber ?? undefined"
      :db-scheme="dbScheme"
      :debug-ids="buildInfoDebugIds"
      @tap="debugTrigger.onTap"
    />
  </AppPage>
</template>

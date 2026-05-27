<template>
  <AppPage :reserve-player-space="player.open">
    <SettingsAccountGroup
      :active-server-id="activeServerId"
      :anonymous="auth.anonymous"
      :email="auth.email"
      :name="auth.name"
      :picture="auth.picture"
      :is-subscribed="subscription.isSubscribed"
      :server-items="serverItems"
      @sign-in-anonymous="triggerSignIn"
      @sign-out="auth.signOut"
      @open-paywall="paywall.requestOpen()"
      @manage-subscription="paywall.requestOpen()"
      @delete-account="onDeleteAccountConfirm"
      @request-region-change="onRequestRegionChange"
    />

    <SettingsAppearanceGroup
      v-model:app-language="appLanguage"
      v-model:show-player-progress="showPlayerProgress"
      v-model:show-player-on-notes="showPlayerOnNotes"
      v-model:highlight-current-sentence="highlightCurrentSentence"
      v-model:auto-scroll="autoScroll"
      v-model:open-transcript-automatically="openTranscriptAutomatically"
      :language-items="languageItems"
      :is-subscribed="subscription.isSubscribed"
      @request-paywall="paywall.requestOpen('autoScroll')"
    />

    <SettingsSadhanaGroup
      v-model:show-activity-tracker="showActivityTracker"
      v-model:notifications-enabled="notificationsEnabled"
      v-model:notifications-time="notificationsTime"
      :smart-library-subtitle="smartLibrary.subtitle.value"
      @open-smart-library="onSmartLibraryEntry"
    />

    <SmartLibraryDialog
      v-model:target-seconds="autoDownloadTargetSeconds"
      v-model:archive-delay="autoArchiveDelay"
      :open="smartLibraryDialogOpen"
      :filter-summary="smartLibrary.filterSummary.value"
      @update:open="smartLibraryDialogOpen = $event"
      @open-filters="smartLibraryFiltersOpen = true"
    />

    <SearchFiltersSheet
      v-model:filters="smartLibrary.filters.value"
      :open="smartLibraryFiltersOpen"
      :sections="smartLibrary.sections.value"
      :can-reset="smartLibrary.activeFilterCount.value > 0"
      @update:open="smartLibraryFiltersOpen = $event"
      @reset="smartLibrary.reset"
    />

    <SettingsDataGroup @export="onExportDatabase" @import-file="onImportFileSelected" />

    <SettingsHelpGroup @open-help="helpOpen = true" @open-privacy-policy="onOpenPrivacyPolicy" />

    <SettingsDangerGroup v-if="debugUnlocked" @clear-cache="onClearCache" />

    <BuildInfo
      :version="version"
      :build-id="buildId"
      :db-number="dbNumber"
      :db-scheme="dbScheme"
      :app-user-id="debugUnlocked ? subscription.appUserId : undefined"
      :lectorium-user-id="debugUnlocked ? (auth.userId ?? undefined) : undefined"
      @tap="debugTrigger.onTap"
    />

    <HelpDialog v-model:open="helpOpen" />
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { alertController, loadingController, toastController } from "@ionic/vue"
import { AppPage, BuildInfo } from "@ui/primitives/index.js"
import {
  SettingsAccountGroup,
  SettingsAppearanceGroup,
  SettingsDangerGroup,
  SettingsDataGroup,
  SettingsHelpGroup,
  SettingsSadhanaGroup,
  SmartLibraryDialog,
} from "@ui/features/settings/index.js"
import { HelpDialog } from "@ui/features/help/index.js"
import { SearchFiltersSheet } from "@ui/features/tracks/search/filters/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { useAnonymousSignInFlow } from "@lectorium/composables/useAnonymousSignInFlow.js"
import { useDebugUnlockTrigger } from "@lectorium/composables/useDebugUnlockTrigger.js"
import { useToast } from "@lectorium/services/useToast.js"
import { AccountDeleteError } from "@infra/auth/capacitor/useCapacitorAuth.js"
import { useSettingsController } from "./SettingsView.controller.js"

const player = usePlayerStore()
const paywall = usePaywallStore()
const auth = useAuthStore()
const lectorium = useLectorium()
const i18n = useI18n()
const { t } = i18n
const toast = useToast()
const {
  version,
  buildId,
  dbScheme,
  dbNumber,
  appLanguage,
  showPlayerProgress,
  showPlayerOnNotes,
  showActivityTracker,
  autoArchiveDelay,
  highlightCurrentSentence,
  autoScroll,
  openTranscriptAutomatically,
  notificationsEnabled,
  notificationsTime,
  autoDownloadTargetSeconds,
  smartLibrary,
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
const { triggerSignIn } = useAnonymousSignInFlow()

const helpOpen = ref(false)
const smartLibraryDialogOpen = ref(false)
const smartLibraryFiltersOpen = ref(false)

async function onDeleteAccountConfirm(opts: { wipeLocal: boolean }): Promise<void> {
  // The action sheet that produced this emit has already dismissed
  // itself, so on success there's nothing to close — the Settings
  // screen reactively swaps the signed-in block for the sign-in CTA
  // once the auth store re-bootstraps anonymous. On failure the user
  // is still signed in with local data intact; the toast surfaces the
  // error and they can try again.
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

async function onRequestRegionChange(newRegionId: string): Promise<void> {
  // Same-region tap shouldn't even reach here (the proxy in
  // SettingsAccountGroup guards), but be defensive.
  if (newRegionId === lectorium.activeServer.value.id) return
  const newRegionName = serverItems.find((s) => s.id === newRegionId)?.title ?? newRegionId

  if (auth.anonymous) {
    // Anonymous: confirm → signOut → switch active server → re-bootstrap
    // anonymous in the new region. No migrate-in; the destination's
    // /auth/anonymous mints a brand-new device-keyed user. The old
    // anonymous user ages out via the source's anon TTL cron.
    const dlg = await alertController.create({
      header: t("settings.regionMigration.confirmAnonymous.title"),
      message: t("settings.regionMigration.confirmAnonymous.message", {
        region: newRegionName,
      }),
      buttons: [
        {
          text: t("settings.regionMigration.confirmAnonymous.cancel"),
          role: "cancel",
        },
        {
          text: t("settings.regionMigration.confirmAnonymous.confirm"),
          role: "confirm",
        },
      ],
    })
    await dlg.present()
    const { role } = await dlg.onDidDismiss()
    if (role !== "confirm") return
    await auth.signOut()
    lectorium.setActiveServerById(newRegionId)
    // signOut already triggers an anonymous re-bootstrap via
    // restore(); explicit restore here would double-bootstrap.
    return
  }

  // Signed-in: confirm → progress spinner → migrateToRegion →
  // success/failure toast. activeServerId v-model flip happens inside
  // the port's onMigrationCompleted callback (composition root); we
  // don't touch the model directly.
  const dlg = await alertController.create({
    header: t("settings.regionMigration.confirmSignedIn.title", {
      region: newRegionName,
    }),
    message: t("settings.regionMigration.confirmSignedIn.message", {
      region: newRegionName,
    }),
    buttons: [
      {
        text: t("settings.regionMigration.confirmSignedIn.cancel"),
        role: "cancel",
      },
      {
        text: t("settings.regionMigration.confirmSignedIn.confirm"),
        role: "confirm",
      },
    ],
  })
  await dlg.present()
  const { role } = await dlg.onDidDismiss()
  if (role !== "confirm") return

  const loading = await loadingController.create({
    message: t("settings.regionMigration.inProgress"),
  })
  await loading.present()
  let result
  try {
    result = await auth.migrateToRegion(newRegionId)
  } finally {
    await loading.dismiss()
  }
  if (result.ok) {
    const ok = await toastController.create({
      message: t("settings.regionMigration.success", { region: newRegionName }),
      duration: 2500,
    })
    await ok.present()
  } else {
    const fail = await toastController.create({
      message: t(`settings.regionMigration.failed.${result.code}`),
      duration: 3500,
    })
    await fail.present()
  }
}

function onSmartLibraryEntry(): void {
  if (subscription.isSubscribed) smartLibraryDialogOpen.value = true
  else paywall.requestOpen("smartLibrary")
}

function onOpenPrivacyPolicy(): void {
  // Same site / per-locale split as the subscription "Privacy Policy" link
  // (see useSubscriptionBinding.ts) — GitHub Pages from modules/web/policy/.
  const base = "https://akdasa-studios.github.io/lectorium"
  const url = (i18n.locale.value as string) === "ru" ? `${base}/ru.html` : `${base}/`
  // Capacitor's webview opens external schemes in the system browser.
  window.open(url, "_blank")
}
</script>

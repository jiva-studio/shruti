import { computed, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import {
  AUTO_ARCHIVE_DELAY_KEY,
  type AutoArchiveDelay,
} from "@lectorium/composables/useAutoArchiveSweep.js"
import { useToast } from "@kit/composables"
import { useConfig } from "@lectorium/composables/useConfig.js"
import {
  useChatLanguage,
  useChatTranslateCitations,
} from "@lectorium/composables/useChatLanguage.js"
import { useSyncChatsEnabled } from "@lectorium/composables/useSyncChats.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useAppLanguageControl } from "@lectorium/composables/useAppLanguageControl.js"
import { useAutoPlayNext } from "@lectorium/composables/useAutoPlayNext.js"
import { useTrackMetadataFields } from "@lectorium/composables/useTrackMetadataFields.js"
import type { TrackMetaConfig } from "@ui/components/tracks/list/index.js"
import { applyDailyReminder } from "@lectorium/composables/useDailyReminder.js"
import type { CdnServer } from "@lib/domain/servers.js"
import { getRegions } from "@lectorium/services/regionsRegistry.js"
import { useAppLanguageList, type SelectorItem } from "./composables/useAppLanguageList.js"
import { useContentLanguageList } from "./composables/useContentLanguageList.js"
import { useDownloadQuotaStore } from "@lectorium/stores/useDownloadQuotaStore.js"
import { useSearchFiltersStore } from "@lectorium/stores/useSearchFiltersStore.js"
import { useActiveServerBinding } from "./composables/useActiveServerBinding.js"
import {
  useSmartLibraryBinding,
  type UseSmartLibraryBindingReturn,
} from "./composables/useSmartLibraryBinding.js"
import { useDangerActions } from "./composables/useDangerActions.js"
import { useDataSettings } from "./composables/useDataSettings.js"
import {
  useSubscriptionBinding,
  type SubscriptionBinding,
} from "./composables/useSubscriptionBinding.js"

export type { SelectorItem }

export interface SettingsControllerReturn {
  /* Build info */
  readonly version: string
  readonly buildId: string
  readonly dbScheme: number
  activeServer: ComputedRef<CdnServer>
  contentDbFile: ComputedRef<string | null>
  dbNumber: ComputedRef<string | null>
  /* Config v-models (backed by IPreferences via useConfig) */
  /** UI language. Writes go through `useAppLanguageControl`, so the setting
   *  moves only once the picked locale's chunk is live. */
  appLanguage: Ref<string>
  /** Chat answer language; empty ⇒ follow appLanguage at the read site. */
  chatLanguage: Ref<string>
  chatTranslateCitations: Ref<boolean>
  /** Device-local "Sync chats" toggle (default on); never itself synced. */
  syncChats: Ref<boolean>
  trackMetaConfig: Ref<TrackMetaConfig>
  showPlayerProgress: Ref<boolean>
  showPlayerOnNotes: Ref<boolean>
  showActivityTracker: Ref<boolean>
  autoArchiveDelay: Ref<AutoArchiveDelay>
  highlightCurrentSentence: Ref<boolean>
  autoScroll: Ref<boolean>
  autoPlayNext: Ref<boolean>
  openTranscriptAutomatically: Ref<boolean>
  notificationsEnabled: Ref<boolean>
  notificationsTime: Ref<[number, number] | undefined>
  autoDownloadTargetSeconds: Ref<number>
  /* Offline-storage budget, in bytes (0 = unlimited) + what it holds today */
  downloadLimitBytes: Ref<number>
  downloadUsedBytes: ComputedRef<number>
  smartLibrary: UseSmartLibraryBindingReturn
  /* Library content languages (the global lecture-language filter SSOT) */
  libraryLanguages: ComputedRef<string[]>
  contentLanguageItems: Ref<SelectorItem[]>
  setLibraryLanguages: (codes: string[]) => void
  /* Selector sources */
  activeServerId: ComputedRef<string>
  serverItems: SelectorItem[]
  languageItems: Ref<SelectorItem[]>
  /* Danger handlers */
  onClearCache: () => Promise<void>
  /* Data export/import handlers */
  onExportDatabase: () => Promise<void>
  onImportFileSelected: (file: File) => Promise<void>
  /* RevenueCat-backed subscription state + handlers */
  subscription: SubscriptionBinding
}

export function useSettingsController(): SettingsControllerReturn {
  const app = useLectorium()
  const { t } = useI18n()
  const toast = useToast()

  const version = __APP_VERSION__
  // Append the short commit hash so the version line reveals which commit a
  // build came from, e.g. "v1.1.2 (2015 · a1b2c3d)". Empty in local/dev builds.
  const buildId = __COMMIT_SHA__ ? `${__BUILD_ID__} · ${__COMMIT_SHA__}` : __BUILD_ID__
  const dbScheme = __DB_SCHEME__
  const activeServer = computed(() => app.activeServer.value)
  const contentDbFile = computed(() => app.contentDbFile.value)
  // Extract the timestamp from "lectorium.20260419213357.db". Falls back
  // to the raw filename if the shape changes so the display still
  // renders something readable.
  const dbNumber = computed(() => {
    const file = app.contentDbFile.value
    if (!file) return null
    const match = /\.(\d+)\.db$/.exec(file)
    return match ? match[1] : file
  })

  /* Config v-models */
  const appLanguage = useAppLanguage()
  // The picker binds to the deferred control, not the raw setting — see
  // useAppLanguageControl for why the write has to wait for the chunk.
  const appLanguageModel = useAppLanguageControl(appLanguage, () => {
    void toast.error(t("settings.appLanguage.loadFailedToast"))
  })
  const chatLanguage = useChatLanguage()
  const chatTranslateCitations = useChatTranslateCitations()
  const syncChats = useSyncChatsEnabled()
  const { raw: trackMetaConfig } = useTrackMetadataFields()
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)
  const autoScroll = useConfig<boolean>("settings.autoScroll", false)
  const autoPlayNext = useAutoPlayNext()
  const openTranscriptAutomatically = useConfig<boolean>(
    "settings.openTranscriptAutomatically",
    false
  )
  const showPlayerProgress = useConfig<boolean>("settings.showPlayerProgress", true)
  const showPlayerOnNotes = useConfig<boolean>("settings.showPlayerOnNotes", true)
  const showActivityTracker = useConfig<boolean>("settings.showActivityTracker", true)
  const autoArchiveDelay = useConfig<AutoArchiveDelay>(AUTO_ARCHIVE_DELAY_KEY, "off")
  const notificationsEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
  const notificationsTime = useConfig<[number, number] | undefined>(
    "settings.notificationsTime",
    [9, 0]
  )
  const autoDownloadTargetSeconds = useConfig<number>("settings.autoDownloadTargetSeconds", 0)
  // Re-measure on entry: lectures may have been downloaded or auto-archived
  // since the store last refreshed, and a stale "of 8 GB" figure is the one
  // number on this screen the user checks BEFORE changing the setting.
  const quota = useDownloadQuotaStore()
  void quota.refresh()
  const downloadLimitBytes = computed<number>({
    get: () => quota.limitBytes,
    set: (value) => {
      quota.limitBytes = value
    },
  })
  const downloadUsedBytes = computed(() => quota.usedBytes)
  const subscription = useSubscriptionBinding()
  const isSubscribedRef = computed(() => subscription.isSubscribed)
  const smartLibrary = useSmartLibraryBinding(
    autoDownloadTargetSeconds,
    autoArchiveDelay,
    isSubscribedRef
  )

  const { activeServerId, serverItems } = useActiveServerBinding({
    servers: getRegions(),
    activeServer: app.activeServer,
  })

  const { items: languageItems } = useAppLanguageList()

  // Library content languages — the global lecture-language filter, backed by
  // the same persisted store the search language facet uses (one SSOT). The
  // setter refuses an empty selection so at least one language always stays on.
  const { items: contentLanguageItems } = useContentLanguageList(app.repositories().languages)
  const filtersStore = useSearchFiltersStore()
  void filtersStore.load()
  const libraryLanguages = computed<string[]>(() => [...filtersStore.languageCodes])
  function setLibraryLanguages(codes: string[]): void {
    if (codes.length > 0) void filtersStore.setLanguages(codes)
  }

  /* Notifications scheduler */
  watch(
    [notificationsEnabled, notificationsTime, appLanguage],
    ([enabled, time]) => {
      const hhmm = time ? `${pad(time[0])}:${pad(time[1])}` : "09:00"
      void applyDailyReminder(
        {
          enabled,
          time: hhmm,
          title: t("app.title"),
          body: t("notifications.timeToListen"),
        },
        { notifications: app.notifications }
      )
    },
    { immediate: true }
  )

  const { onClearCache } = useDangerActions(app)
  const { onExportDatabase, onImportFileSelected } = useDataSettings(app)

  return {
    version,
    buildId,
    dbScheme,
    activeServer,
    contentDbFile,
    dbNumber,
    appLanguage: appLanguageModel,
    chatLanguage,
    chatTranslateCitations,
    syncChats,
    trackMetaConfig,
    showPlayerProgress,
    showPlayerOnNotes,
    showActivityTracker,
    autoArchiveDelay,
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
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}

declare const __APP_VERSION__: string
declare const __BUILD_ID__: string
declare const __COMMIT_SHA__: string
declare const __DB_SCHEME__: number

import { computed, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import {
  AUTO_ARCHIVE_DELAY_KEY,
  type AutoArchiveDelay,
} from "@lectorium/composables/useAutoArchiveSweep.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useAutoPlayNext } from "@lectorium/composables/useAutoPlayNext.js"
import { useTrackMetadataFields } from "@lectorium/composables/useTrackMetadataFields.js"
import type { TrackMetaConfig } from "@ui/components/tracks/list/index.js"
import { applyDailyReminder } from "@lectorium/composables/useDailyReminder.js"
import type { CdnServer } from "@lib/domain/servers.js"
import { getRegions } from "@lectorium/services/regionsRegistry.js"
import { useAppLanguageList, type SelectorItem } from "./composables/useAppLanguageList.js"
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
  appLanguage: Ref<string>
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
  smartLibrary: UseSmartLibraryBindingReturn
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
  const appLanguage = useConfig<string>("settings.appLanguage", "en")
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

  const { items: languageItems } = useAppLanguageList(app.repositories().languages)

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
    appLanguage,
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
    smartLibrary,
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

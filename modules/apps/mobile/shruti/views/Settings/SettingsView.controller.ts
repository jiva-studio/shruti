import { computed, watch, type ComputedRef, type Ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { applyDailyReminder } from "@shruti/composables/useDailyReminder.js"
import type { CdnServer } from "@lib/domain/servers.js"
import { useAppLanguageList, type SelectorItem } from "./composables/useAppLanguageList.js"
import { useActiveServerBinding } from "./composables/useActiveServerBinding.js"
import { useDangerActions } from "./composables/useDangerActions.js"
import { useDataSettings } from "./composables/useDataSettings.js"

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
  showPlayerProgress: Ref<boolean>
  showNotesTab: Ref<boolean>
  showActivityTracker: Ref<boolean>
  highlightCurrentSentence: Ref<boolean>
  openTranscriptAutomatically: Ref<boolean>
  notificationsEnabled: Ref<boolean>
  notificationsTime: Ref<[number, number] | undefined>
  /* Selector sources */
  activeServerId: Ref<string>
  serverItems: SelectorItem[]
  languageItems: Ref<SelectorItem[]>
  /* Danger handlers */
  onClearCache: () => Promise<void>
  onClearUserData: () => Promise<void>
  /* Data export/import handlers */
  onExportDatabase: () => Promise<void>
  onImportFileSelected: (file: File) => Promise<void>
}

export function useSettingsController(): SettingsControllerReturn {
  const app = useShruti()

  const version = __APP_VERSION__
  const buildId = __BUILD_ID__
  const dbScheme = __DB_SCHEME__
  const activeServer = computed(() => app.activeServer.value)
  const contentDbFile = computed(() => app.contentDbFile.value)
  // Extract the timestamp from "shruti.20260419213357.db". Falls back
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
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)
  const openTranscriptAutomatically = useConfig<boolean>(
    "settings.openTranscriptAutomatically",
    true
  )
  const showPlayerProgress = useConfig<boolean>("settings.showPlayerProgress", true)
  const showNotesTab = useConfig<boolean>("settings.notes.showTab", true)
  const showActivityTracker = useConfig<boolean>("settings.showActivityTracker", true)
  const notificationsEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
  const notificationsTime = useConfig<[number, number] | undefined>(
    "settings.notificationsTime",
    [9, 0]
  )

  const { activeServerId, serverItems } = useActiveServerBinding({
    servers: app.appConfig.servers,
    initial: app.activeServer.value,
    setActiveServer: (server) => app.setActiveServer(server),
  })

  const { items: languageItems } = useAppLanguageList(app.repositories().languages)

  /* Notifications scheduler */
  watch(
    [notificationsEnabled, notificationsTime],
    ([enabled, time]) => {
      const hhmm = time ? `${pad(time[0])}:${pad(time[1])}` : "09:00"
      void applyDailyReminder({ enabled, time: hhmm }, { notifications: app.notifications })
    },
    { immediate: true }
  )

  const { onClearCache, onClearUserData } = useDangerActions(app)
  const { onExportDatabase, onImportFileSelected } = useDataSettings(app)

  return {
    version,
    buildId,
    dbScheme,
    activeServer,
    contentDbFile,
    dbNumber,
    appLanguage,
    showPlayerProgress,
    showNotesTab,
    showActivityTracker,
    highlightCurrentSentence,
    openTranscriptAutomatically,
    notificationsEnabled,
    notificationsTime,
    activeServerId,
    serverItems,
    languageItems,
    onClearCache,
    onClearUserData,
    onExportDatabase,
    onImportFileSelected,
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}

declare const __APP_VERSION__: string
declare const __BUILD_ID__: string
declare const __DB_SCHEME__: number

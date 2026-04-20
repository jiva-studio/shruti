import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { toastController } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { applyDailyReminder } from "@shruti/composables/useDailyReminder.js"
import { useDebugStore } from "@shruti/stores/useDebugStore.js"
import type { Language } from "@lib/domain/language.js"
import type { CdnServer } from "@lib/domain/servers.js"

export interface SelectorItem {
  id: string
  title: string
}

export interface SettingsControllerReturn {
  /* Build info */
  readonly version: string
  readonly buildId: string
  readonly dbScheme: number
  activeServer: ComputedRef<CdnServer>
  contentDbFile: ComputedRef<string | null>
  /* Debug unlock */
  debugUnlocked: ComputedRef<boolean>
  onVersionTap: () => Promise<void>
  /* Config v-models (backed by IPreferences via useConfig) */
  appLanguage: Ref<string>
  showPlayerProgress: Ref<boolean>
  showNotesTab: Ref<boolean>
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
}

export function useSettingsController(): SettingsControllerReturn {
  const app = useShruti()
  const debug = useDebugStore()

  const version = __APP_VERSION__
  const buildId = __BUILD_ID__
  const dbScheme = __DB_SCHEME__
  const activeServer = computed(() => app.activeServer.value)
  const contentDbFile = computed(() => app.contentDbFile.value)
  const debugUnlocked = computed(() => debug.unlocked)

  /* Config v-models */
  const appLanguage = useConfig<string>("settings.appLanguage", "en")
  const highlightCurrentSentence = useConfig<boolean>("settings.highlightCurrentSentence", true)
  const openTranscriptAutomatically = useConfig<boolean>(
    "settings.openTranscriptAutomatically",
    false
  )
  const showPlayerProgress = useConfig<boolean>("settings.showPlayerProgress", false)
  const showNotesTab = useConfig<boolean>("settings.notes.showTab", true)
  const notificationsEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
  const notificationsTime = useConfig<[number, number] | undefined>(
    "settings.notificationsTime",
    [9, 0]
  )

  /* Active CDN */
  const activeServerId = ref<string>(app.activeServer.value.id)
  const serverItems: SelectorItem[] = app.appConfig.servers.map((s) => ({
    id: s.id,
    title: s.name,
  }))

  watch(activeServerId, (next) => {
    const server = app.appConfig.servers.find((s) => s.id === next)
    if (server) app.setActiveServer(server)
  })

  /* Language chooser source list */
  const languageItems = ref<SelectorItem[]>([])

  onMounted(async () => {
    try {
      const langs: readonly Language[] = await app.repositories().languages.listAll()
      languageItems.value = langs.map((l) => ({ id: l.code, title: l.fullName }))
    } catch {
      languageItems.value = [
        { id: "en", title: "English" },
        { id: "ru", title: "Русский" },
      ]
    }
  })

  /* Notifications scheduler */
  watch(
    [notificationsEnabled, notificationsTime],
    ([enabled, time]) => {
      const hhmm = time ? `${pad(time[0])}:${pad(time[1])}` : "09:00"
      void applyDailyReminder({ enabled, time: hhmm }, { notifications: app.notifications })
    },
    { immediate: true }
  )

  /* Debug unlock */
  async function onVersionTap(): Promise<void> {
    if (debug.registerUnlockTap()) {
      const toast = await toastController.create({
        message: "Debug mode enabled",
        duration: 1500,
        position: "top",
        color: "success",
      })
      await toast.present()
    }
  }

  /* Danger handlers */
  async function onClearCache(): Promise<void> {
    await app.filesStorage.clearAll()
  }

  async function onClearUserData(): Promise<void> {
    const repos = app.repositories()
    await repos.notes.clearAll()
    await repos.playlistItems.clearAll()
    await repos.mediaItems.clearAll()
    await app.preferences.remove("search.filters.v2")
  }

  return {
    version,
    buildId,
    dbScheme,
    activeServer,
    contentDbFile,
    debugUnlocked,
    onVersionTap,
    appLanguage,
    showPlayerProgress,
    showNotesTab,
    highlightCurrentSentence,
    openTranscriptAutomatically,
    notificationsEnabled,
    notificationsTime,
    activeServerId,
    serverItems,
    languageItems,
    onClearCache,
    onClearUserData,
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}

declare const __APP_VERSION__: string
declare const __BUILD_ID__: string
declare const __DB_SCHEME__: number

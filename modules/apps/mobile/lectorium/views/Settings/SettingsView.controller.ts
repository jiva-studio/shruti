import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { alertController, toastController } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { useToast } from "@lectorium/services/useToast.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { applyDailyReminder } from "@lectorium/composables/useDailyReminder.js"
import { useDebugStore } from "@lectorium/stores/useDebugStore.js"
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
  dbNumber: ComputedRef<string | null>
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
  const app = useLectorium()
  const debug = useDebugStore()
  const { t } = useI18n()
  const toast = useToast()

  const version = __APP_VERSION__
  const buildId = __BUILD_ID__
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
    } catch (err) {
      // Falling back silently meant users in unsupported locales saw
      // only en/ru and assumed the app didn't support their language.
      // Tell them the list couldn't load.
      console.error("[settings] languages.listAll failed:", err)
      languageItems.value = [
        { id: "en", title: "English" },
        { id: "ru", title: "Русский" },
      ]
      void toast.error(t("errors.languageListUnavailable"))
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
    // Behind a 5-tap debug unlock today, but the action is irreversible
    // (notes, playlist, downloads, filters all gone) so a confirm
    // dialog is the bare minimum.
    const alert = await alertController.create({
      header: t("settings.danger.confirmClearUserData.header"),
      message: t("settings.danger.confirmClearUserData.message"),
      buttons: [
        { text: t("settings.danger.confirmClearUserData.cancel"), role: "cancel" },
        { text: t("settings.danger.confirmClearUserData.confirm"), role: "destructive" },
      ],
    })
    await alert.present()
    const { role } = await alert.onDidDismiss()
    if (role !== "destructive") return
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
    dbNumber,
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

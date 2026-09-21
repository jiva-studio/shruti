import { computed, ref, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { alertController } from "@ionic/vue"
import router from "@shruti/router/index.js"
import { useToast } from "@kit/composables"
import { useChatStore, type ChatSession } from "@shruti/stores/useChatStore.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"

export interface UseChatSessionsReturn {
  isHistoryOpen: Ref<boolean>
  searchQuery: Ref<string>
  filteredSessions: Ref<ChatSession[]>
  onNewSession: () => void
  onOpenHistory: () => Promise<void>
  onCloseHistory: () => void
  onPickSession: (id: string) => Promise<void>
  onDeleteSession: (id: string) => Promise<void>
  onDeleteAllSessions: () => Promise<void>
}

export interface ChatSessionsDeps {
  sessionIdFromRoute: () => string | null
  scrollReady: Ref<boolean>
  ensureSessionFromRoute: () => Promise<void>
}

/** The history sheet and everything that opens, closes or deletes a session. */
export function useChatSessions(deps: ChatSessionsDeps): UseChatSessionsReturn {
  const store = useChatStore()
  const { t } = useI18n()
  const toast = useToast()

  const isHistoryOpen = ref(false)
  const searchQuery = ref<string>("")
  // Filtered in JS against `store.sessions` (capped at 200), so it recomputes
  // with the store and needs no sync watcher.
  const filteredSessions = computed<ChatSession[]>(() => store.searchSessions(searchQuery.value))

  function toChatRoot(): void {
    if (deps.sessionIdFromRoute() !== null) void router.replace({ name: "chat", query: {} })
  }

  function onNewSession(): void {
    store.startNewSession()
    toChatRoot()
  }

  async function onOpenHistory(): Promise<void> {
    await store.refreshSessions()
    searchQuery.value = ""
    isHistoryOpen.value = true
  }

  function onCloseHistory(): void {
    isHistoryOpen.value = false
  }

  /**
   * Only the URL is updated; the single `?session=` watcher then runs the
   * open → scroll → reveal the deep links take. Doing it here as well was a
   * double open and a double scroll.
   */
  async function onPickSession(id: string): Promise<void> {
    isHistoryOpen.value = false
    if (deps.sessionIdFromRoute() === id) {
      // The URL already points here, so the watcher will not fire: drive the
      // idempotent open directly.
      await deps.ensureSessionFromRoute()
      return
    }
    // Hide the current content first, or the old bubbles linger for a frame.
    deps.scrollReady.value = false
    void router.replace({ name: "chat", query: { session: id } })
  }

  async function onDeleteSession(id: string): Promise<void> {
    const wasActive = store.activeSessionId === id
    await store.deleteSession(id)
    if (wasActive) toChatRoot()
  }

  async function clearAll(): Promise<void> {
    try {
      await store.clearAll()
      searchQuery.value = ""
      toChatRoot()
      void toast.info(t("chat.clearedToast"))
    } catch (err) {
      reportError("chat", err)
      void toast.error(t("chat.errNetwork"))
    }
  }

  async function onDeleteAllSessions(): Promise<void> {
    const dialog = await alertController.create({
      header: t("chat.clearHistory"),
      message: t("chat.clearHistoryConfirm"),
      buttons: [
        { text: t("app.cancel"), role: "cancel" },
        {
          text: t("app.delete"),
          role: "destructive",
          handler: () => {
            void clearAll()
          },
        },
      ],
    })
    await dialog.present()
  }

  return {
    isHistoryOpen,
    searchQuery,
    filteredSessions,
    onNewSession,
    onOpenHistory,
    onCloseHistory,
    onPickSession,
    onDeleteSession,
    onDeleteAllSessions,
  }
}

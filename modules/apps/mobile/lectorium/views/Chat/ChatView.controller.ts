import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from "vue"
import { useRoute } from "vue-router"
import router from "@lectorium/router/index.js"
import { useI18n } from "vue-i18n"
import { alertController } from "@ionic/vue"
import { App, type AppState } from "@capacitor/app"
import { useChatStore, type ChatMessage, type ChatSession } from "@lectorium/stores/useChatStore.js"
import { useToast } from "@lectorium/services/useToast.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useTrackUserState } from "@lectorium/composables/useTrackUserState.js"
import { formatTimestamp } from "@lectorium/composables/formatTimestamp.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"

export interface OutlineChapterPick {
  trackId: string
  item: { startMs: number; title: string }
  nextItem: { startMs: number; title: string } | null
}

export interface ChatControllerReturn {
  messages: ComputedRef<ChatMessage[]>
  sessions: ComputedRef<ChatSession[]>
  activeSessionId: ComputedRef<string | null>
  sending: ComputedRef<boolean>
  isHistoryOpen: Ref<boolean>
  hasMessages: ComputedRef<boolean>
  hasCurrentTrack: ComputedRef<boolean>
  /** True once the user DB has ≥1 listening_sessions row. Drives the
   *  "recap last lecture" suggestion chip on the empty state. */
  hasRecentListening: Ref<boolean>
  contentRef: Ref<HTMLElement | null>
  searchQuery: Ref<string>
  filteredSessions: Ref<ChatSession[]>
  /** Session ids with an unreplied agent-initiated message — passed to
   *  RecentSessions and ChatSessionList for the per-session dot marker. */
  unseenProactiveSessionIds: ComputedRef<ReadonlySet<string>>
  onSend: (text: string) => Promise<void>
  onNewSession: () => void
  onOpenHistory: () => Promise<void>
  onCloseHistory: () => void
  onPickSession: (id: string) => Promise<void>
  onDeleteSession: (id: string) => Promise<void>
  onDeleteAllSessions: () => Promise<void>
  onPickChapter: (pick: OutlineChapterPick) => Promise<void>
}

/**
 * View controller for ChatView. Owns the modal/state plumbing the
 * template needs and delegates persistence + streaming to the chat
 * store. Auto-scrolls to the bottom whenever the message list grows
 * (new user turn, streaming delta, finalised assistant message).
 */
export function useChatController(): ChatControllerReturn {
  const store = useChatStore()
  const player = usePlayerStore()
  // `useRoute()` is reactive (needed for the chat-session watcher
  //  below), but we add optional chains everywhere because the
  //  Vite-dev DI race + IonRouterOutlet quirks occasionally surface
  //  `undefined` here on first render. `router` uses the singleton
  //  import to avoid the same race for navigations.
  const route = useRoute()
  const { t } = useI18n()
  const toast = useToast()

  const isHistoryOpen = ref(false)
  // The IonContent's inner scroller element — captured via template ref
  // on the wrapper div inside <ion-content> for auto-scroll-to-bottom.
  const contentRef = ref<HTMLElement | null>(null)

  const hasMessages = computed(() => store.messages.length > 0)
  /** Drives the "Recap what I just listened to" suggestion chip. */
  const hasCurrentTrack = computed(() => player.open && !!player.trackId)
  /** Set once on mount from the user DB. Used to pick the "recap last
   *  lecture" chip when the player isn't open. The chip is a pure-props
   *  presenter — the fetch lives here so we can centralise listening-
   *  state lookups instead of letting every chip reach into the DB. */
  const trackUserState = useTrackUserState()
  const hasRecentListening = ref(false)

  const searchQuery = ref<string>("")
  // Filter runs in JS against `store.sessions` (capped at 200) so it
  // auto-recomputes whenever the store list mutates — no separate
  // sync watcher needed.
  const filteredSessions = computed<ChatSession[]>(() => store.searchSessions(searchQuery.value))

  async function ensureSessionFromRoute(): Promise<void> {
    const param = route?.params?.sessionId
    const sessionId = Array.isArray(param) ? param[0] : param
    if (typeof sessionId === "string" && sessionId.length > 0) {
      try {
        await store.openSession(sessionId)
      } catch (err) {
        console.warn("chat: failed to open session", err)
        store.startNewSession()
      }
    } else if (store.activeSessionId == null && store.messages.length === 0) {
      // Tab landing — empty state, no implicit session create.
      store.startNewSession()
    }
  }

  async function onSend(text: string): Promise<void> {
    await store.sendMessage(text)
    if (store.lastError) {
      surfaceError()
    }
    // After both the user echo and the streamed assistant reply settle,
    // pin the view to the bottom so the latest delta is in sight.
    await nextTick()
    scrollToBottom()
  }

  function onNewSession(): void {
    store.startNewSession()
    if (route?.name === "chat-session") {
      void router.replace({ name: "chat" })
    }
  }

  async function onOpenHistory(): Promise<void> {
    await store.refreshSessions()
    searchQuery.value = ""
    isHistoryOpen.value = true
  }

  function onCloseHistory(): void {
    isHistoryOpen.value = false
  }

  async function onPickSession(id: string): Promise<void> {
    isHistoryOpen.value = false
    await store.openSession(id)
    void router.replace({ name: "chat-session", params: { sessionId: id } })
    await nextTick()
    scrollToBottom()
  }

  async function onDeleteSession(id: string): Promise<void> {
    const wasActive = store.activeSessionId === id
    await store.deleteSession(id)
    if (wasActive && route?.name === "chat-session") {
      void router.replace({ name: "chat" })
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
            void (async () => {
              try {
                await store.clearAll()
                searchQuery.value = ""
                if (route?.name === "chat-session") {
                  void router.replace({ name: "chat" })
                }
                toast.info(t("chat.clearedToast"))
              } catch (err) {
                console.warn("chat: failed to clear all sessions", err)
                void toast.error(t("chat.errNetwork"))
              }
            })()
          },
        },
      ],
    })
    await dialog.present()
  }

  /** Default chapter window when there's no "next" item to bound it. */
  const FALLBACK_CHAPTER_MS = 5 * 60 * 1000

  /** User tapped an outline chapter inside an OutlineCard. Assemble the
   *  recap prompt + focus fragment and dispatch a chat turn. Prompt
   *  assembly + ms math live here (not in the card) so the card stays
   *  pure presentation. */
  async function onPickChapter(pick: OutlineChapterPick): Promise<void> {
    const { trackId, item, nextItem } = pick
    const endMs = nextItem
      ? Math.max(nextItem.startMs, item.startMs + 1000)
      : item.startMs + FALLBACK_CHAPTER_MS
    const text = t("chat.outlineRecapPrompt", {
      from: formatTimestamp(item.startMs),
      to: formatTimestamp(endMs),
      title: item.title,
    })
    await store.sendMessage(text, {
      focus: {
        track_id: trackId,
        start_ms: item.startMs,
        end_ms: endMs,
        title: item.title,
      },
    })
    await nextTick()
    scrollToBottom()
  }

  function surfaceError(): void {
    const err = store.lastError
    if (!err) return
    if (err.code === "rate_limited") {
      void toast.error(t("chat.errRate"))
    } else if (err.code === "max_turns_exceeded") {
      // Agent didn't converge within MAX_TOOL_TURNS. Network was fine —
      // the model just kept calling tools without producing a final
      // answer. "Couldn't reach the chat service" would be a lie.
      void toast.error(t("chat.errMaxTurns"))
    } else if (err.code.startsWith("http_5")) {
      void toast.error(t("chat.errServiceNotReady"))
    } else {
      void toast.error(t("chat.errNetwork"))
    }
  }

  function scrollToBottom(): void {
    const el = contentRef.value
    if (!el) return
    // Find the nearest scrollable ancestor — IonContent's shadow DOM
    // owns the actual scroller; we target the wrapper div whose
    // overflow we control directly via CSS, so a simple scrollTo on
    // the parent IonContent host suffices via Ionic's auto-shim.
    const host = el.closest("ion-content") as
      | (HTMLElement & {
          scrollToBottom?: (durationMs: number) => Promise<void>
        })
      | null
    if (host && typeof host.scrollToBottom === "function") {
      void host.scrollToBottom(180)
    } else {
      el.scrollTop = el.scrollHeight
    }
  }

  watch(
    () => store.messages.length,
    async () => {
      await nextTick()
      scrollToBottom()
    }
  )

  watch(
    () => route?.params?.sessionId,
    () => {
      void ensureSessionFromRoute()
    }
  )

  const appLanguage = useAppLanguage()

  /** Re-poke `/title` for sessions whose initial call failed. Capped to
   *  3 retries per session and a 7-day age window — see useChatStore. */
  function retryTitles(): void {
    const lang = appLanguage.value.startsWith("en") ? "en" : "ru"
    void store.retryPendingTitles(lang)
  }

  let resumeHandle: { remove(): Promise<void> } | null = null

  onMounted(() => {
    void (async () => {
      await store.refreshSessions()
      await ensureSessionFromRoute()
      retryTitles()
    })()
    void (async () => {
      try {
        const recent = await trackUserState.listRecent(1)
        hasRecentListening.value = recent.length > 0
      } catch {
        hasRecentListening.value = false
      }
    })()
    void (async () => {
      resumeHandle = await App.addListener("appStateChange", (state: AppState) => {
        if (state.isActive) retryTitles()
      })
    })()
  })

  onBeforeUnmount(() => {
    if (resumeHandle) {
      void resumeHandle.remove()
      resumeHandle = null
    }
  })

  return {
    messages: computed(() => [...store.messages]),
    sessions: computed(() => [...store.sessions]),
    activeSessionId: computed(() => store.activeSessionId),
    sending: computed(() => store.sending),
    isHistoryOpen,
    hasMessages,
    hasCurrentTrack,
    hasRecentListening,
    contentRef,
    searchQuery,
    filteredSessions,
    unseenProactiveSessionIds: computed(() => store.unseenProactiveSessionIds),
    onSend,
    onNewSession,
    onOpenHistory,
    onCloseHistory,
    onPickSession,
    onDeleteSession,
    onDeleteAllSessions,
    onPickChapter,
  }
}

import { computed, nextTick, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useRoute } from "vue-router"
import router from "@shruti/router/index.js"
import { useI18n } from "vue-i18n"
import { alertController } from "@ionic/vue"
import { useChatStore, type ChatMessage, type ChatSession } from "@shruti/stores/useChatStore.js"
import { useToast } from "@shruti/services/useToast.js"
import { useTrackUserState } from "@shruti/composables/useTrackUserState.js"
import { formatTimestamp } from "@shruti/composables/formatTimestamp.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"

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
  onRetry: (messageId: string) => Promise<void>
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
    // Errors surface as inline failed-bubbles via `applyTurnEvent →
    // error` inside the store; no toast hop needed. `store.lastError`
    // remains populated for telemetry/debug but the controller no
    // longer reads from it.
    await store.sendMessage(text)
  }

  async function onRetry(messageId: string): Promise<void> {
    await store.retryLast(messageId)
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
  }

  /**
   * Scroll a specific message's bubble to the top of the viewport. Used
   * to pin a freshly-sent user message in sight while the assistant
   * streams its reply below — the user wrote that question, so seeing
   * the question stay anchored is what they'd expect. We do NOT chase
   * the streaming reply downward; the user reads at their own pace.
   *
   * Uses IonContent's `scrollToPoint` (the inner shadow-DOM scroller is
   * what actually moves); falls back to direct `scrollTop` on the
   * wrapper if IonContent isn't reachable.
   */
  /**
   * Walk the message list from the end and return the id of the
   * last entry whose role is `user`. Used by the pin-to-top watcher
   * when the trigger is the streaming-placeholder append — at that
   * point the user message sits one slot above the placeholder.
   */
  function findLastUserMessageId(
    messages: readonly { id: string; role: "user" | "assistant" }[]
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id
    }
    return null
  }

  function scrollMessageToTop(messageId: string): void {
    const el = contentRef.value
    if (!el) return
    const target = el.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`
    ) as HTMLElement | null
    if (!target) return
    // The fixed-top fade gradient overlays the top of the scroll
    // container — its real height depends on the safe-area inset
    // (notch / status bar varies by device), the action-row buttons
    // (44px) and the gradient bottom padding (28px). Measuring it at
    // scroll time keeps the offset honest across devices and any
    // future tweaks to the header layout. Falls back to 56px if the
    // element isn't found (e.g. test environment).
    const fixedTop = document.querySelector(".chat-fixed-top") as HTMLElement | null
    const topPad = fixedTop ? fixedTop.getBoundingClientRect().height + 8 : 56
    const y = Math.max(0, target.offsetTop - topPad)
    const host = el.closest("ion-content") as
      | (HTMLElement & {
          scrollToPoint?: (x: number, y: number, durationMs: number) => Promise<void>
        })
      | null
    if (host && typeof host.scrollToPoint === "function") {
      void host.scrollToPoint(0, y, 220)
    } else {
      el.scrollTop = y
    }
  }

  /**
   * Pin the just-sent user message to the top of the viewport. The
   * store fires two events back-to-back at the start of a turn:
   * first the user message is appended (last.role === 'user'), then
   * the streaming-placeholder assistant bubble is appended
   * (last.role === 'assistant', last.streaming === true). We re-fire
   * the scroll on BOTH:
   *
   *   - on user-message append, there's nothing below the user bubble
   *     yet, so the browser has nowhere to scroll — the call is a
   *     no-op. We make it anyway as a cheap first try.
   *   - on placeholder append, the placeholder's `min-height` (set in
   *     `ChatMessageBubble.vue`) creates the scroll room and the call
   *     actually moves the user message to the top.
   *
   * Streamed deltas mutate the same placeholder and never change
   * `last.id`, so they don't re-trigger. Once the placeholder is
   * swapped for the finalised reply, `last.streaming` becomes
   * undefined and the watcher exits early. Session open / switch
   * lands on a non-streaming assistant message as the last element,
   * also a no-op. The user, not the controller, owns scroll position
   * from there.
   */
  watch(
    () => {
      const last = store.messages[store.messages.length - 1]
      if (!last) return null
      return { id: last.id, role: last.role, streaming: last.streaming === true }
    },
    async (snapshot) => {
      if (!snapshot) return
      const isPlaceholder = snapshot.role === "assistant" && snapshot.streaming
      const isUserMessage = snapshot.role === "user"
      if (!isUserMessage && !isPlaceholder) return
      await nextTick()
      // For the placeholder case the scroll target is the user
      // message right above it, not the placeholder itself. Walk
      // from the end to find the last user message in the list.
      const target = isUserMessage ? snapshot.id : findLastUserMessageId(store.messages)
      if (target) scrollMessageToTop(target)
    },
    { deep: false }
  )

  watch(
    () => route?.params?.sessionId,
    () => {
      void ensureSessionFromRoute()
    }
  )

  onMounted(() => {
    void (async () => {
      await store.refreshSessions()
      await ensureSessionFromRoute()
    })()
    void (async () => {
      try {
        const recent = await trackUserState.listRecent(1)
        hasRecentListening.value = recent.length > 0
      } catch {
        hasRecentListening.value = false
      }
    })()
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
    onRetry,
  }
}

import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useChatStore, type ChatMessage, type ChatSession } from "@shruti/stores/useChatStore.js"
import { useTrackUserState } from "@shruti/composables/useTrackUserState.js"
import { formatTimestamp } from "@shruti/composables/formatTimestamp.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useChatScroll } from "./useChatScroll.js"
import { useChatSessionRoute } from "./useChatSessionRoute.js"
import { useChatSessions } from "./useChatSessions.js"

export interface OutlineChapterPick {
  trackId: string
  item: { startMs: number; title: string }
  nextItem: { startMs: number; title: string } | null
}

export interface SessionHeaderInfo {
  readonly title: string | null
  readonly authorName: string | null
  readonly date: string | null
  readonly location: string | null
}

export interface ChatControllerReturn {
  messages: ComputedRef<ChatMessage[]>
  sessions: ComputedRef<ChatSession[]>
  activeSessionId: ComputedRef<string | null>
  sending: ComputedRef<boolean>
  isHistoryOpen: Ref<boolean>
  hasMessages: ComputedRef<boolean>
  hasCurrentTrack: ComputedRef<boolean>
  /** True once the user DB has a listening row — drives the "recap last
   *  lecture" suggestion chip on the empty state. */
  hasRecentListening: Ref<boolean>
  contentRef: Ref<HTMLElement | null>
  /** False while a session is loading and positioning itself. Bound to a
   *  visibility class so the user never sees the frame at scrollTop 0. */
  scrollReady: Ref<boolean>
  searchQuery: Ref<string>
  filteredSessions: Ref<ChatSession[]>
  /** Session ids with an unreplied agent-initiated message, for the dot. */
  unseenProactiveSessionIds: ComputedRef<ReadonlySet<string>>
  /** Focus message ids whose `/questions` round-trip is in flight, so each
   *  focus card can hold a placeholder until its chips land. */
  loadingFocusIds: ComputedRef<ReadonlySet<string>>
  /** Bibliographic header above the list; null for a free-form chat. */
  sessionHeader: ComputedRef<SessionHeaderInfo | null>
  /** Reactive ping the view watches to focus the textarea after the Ask-Sadhu
   *  navigation. */
  inputFocusToken: ComputedRef<number>
  /** True while the rate-limit window from the last 429 is still open, so the
   *  composer can refuse another quota-rejected send. */
  isComposeBlocked: ComputedRef<boolean>
  /** UnixMs deadline behind `isComposeBlocked`, for the reset placeholder. */
  composeBlockedUntil: ComputedRef<number | null>
  /** Per-day usage from the SSE `usage` event, for the chip above the
   *  composer. */
  chatUsage: ComputedRef<{ current: number; limit: number; resetsAtEpoch: number } | null>
  onSend: (text: string) => Promise<void>
  /** Aborts the streaming turn; the store keeps partial prose under
   *  `meta.error.kind="stopped"`. */
  onCancel: () => void
  onNewSession: () => void
  onOpenHistory: () => Promise<void>
  onCloseHistory: () => void
  onPickSession: (id: string) => Promise<void>
  onDeleteSession: (id: string) => Promise<void>
  onDeleteAllSessions: () => Promise<void>
  onPickChapter: (pick: OutlineChapterPick) => Promise<void>
  onPickSuggestion: (text: string) => Promise<void>
  onRetry: (messageId: string) => Promise<void>
}

/** Default chapter window when there is no "next" item to bound it. */
const FALLBACK_CHAPTER_MS = 5 * 60 * 1000

/**
 * View controller for ChatView: the state the template needs, with
 * persistence and streaming left to the chat store, scrolling to
 * `useChatScroll` and the open session to `useChatSessionRoute`.
 */
export function useChatController(): ChatControllerReturn {
  const store = useChatStore()
  const player = usePlayerStore()
  const { t } = useI18n()

  const scroll = useChatScroll()
  const routeBinding = useChatSessionRoute(scroll)
  const sessions = useChatSessions({
    sessionIdFromRoute: routeBinding.sessionIdFromRoute,
    scrollReady: routeBinding.scrollReady,
    ensureSessionFromRoute: routeBinding.ensureSessionFromRoute,
  })

  const hasMessages = computed(() => store.messages.length > 0)
  const hasCurrentTrack = computed(() => player.open && !!player.trackId)
  // Read once on mount, so the suggestion chips stay pure-props presenters
  // instead of each reaching into the DB.
  const trackUserState = useTrackUserState()
  const hasRecentListening = ref(false)

  async function onSend(text: string): Promise<void> {
    // Failures surface as inline failed bubbles from the store; no toast hop.
    await store.sendMessage(text)
  }

  function onCancel(): void {
    store.cancelStream()
  }

  async function onRetry(messageId: string): Promise<void> {
    await store.retryLast(messageId)
  }

  /**
   * A suggestion pill spawns a brand-new session and dispatches at once — the
   * prompt must never flash into the input bar.
   *
   * `sendMessage` is the single source of session creation: pre-creating one
   * here raced anything that nulled `activeSessionId` between the two awaits
   * and left the user with two empty sessions in history.
   */
  async function onPickSuggestion(text: string): Promise<void> {
    store.startNewSession()
    void store.sendMessage(text)
  }

  /** Prompt assembly and the ms math live here, not in the outline card, so
   *  the card stays pure presentation. */
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
      focus: { track_id: trackId, start_ms: item.startMs, end_ms: endMs, title: item.title },
    })
  }

  onMounted(() => {
    void (async () => {
      await store.refreshSessions()
      await routeBinding.ensureSessionFromRoute()
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

  // Every focus in a focused session belongs to the same track and shares its
  // metadata, so the first one is what gave the session its identity.
  const sessionHeader = computed<SessionHeaderInfo | null>(() => {
    const firstFocus = store.messages.find((m) => m.focus)?.focus
    if (!firstFocus) return null
    return {
      title: firstFocus.trackTitle ?? null,
      authorName: firstFocus.authorName ?? null,
      date: firstFocus.date ?? null,
      location: firstFocus.location ?? null,
    }
  })

  return {
    messages: computed(() => [...store.messages]),
    sessions: computed(() => [...store.sessions]),
    activeSessionId: computed(() => store.activeSessionId),
    sending: computed(() => store.sending),
    isHistoryOpen: sessions.isHistoryOpen,
    hasMessages,
    hasCurrentTrack,
    hasRecentListening,
    contentRef: scroll.contentRef,
    scrollReady: routeBinding.scrollReady,
    searchQuery: sessions.searchQuery,
    filteredSessions: sessions.filteredSessions,
    unseenProactiveSessionIds: computed(() => store.unseenProactiveSessionIds),
    loadingFocusIds: computed(() => store.loadingFocusIds),
    sessionHeader,
    inputFocusToken: computed(() => store.inputFocusToken),
    isComposeBlocked: computed(() => store.isComposeBlocked),
    composeBlockedUntil: computed(() => store.composeBlockedUntil),
    chatUsage: computed(() => store.chatUsage),
    onSend,
    onCancel,
    onNewSession: sessions.onNewSession,
    onOpenHistory: sessions.onOpenHistory,
    onCloseHistory: sessions.onCloseHistory,
    onPickSession: sessions.onPickSession,
    onDeleteSession: sessions.onDeleteSession,
    onDeleteAllSessions: sessions.onDeleteAllSessions,
    onPickChapter,
    onPickSuggestion,
    onRetry,
  }
}

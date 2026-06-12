import { computed, nextTick, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useRoute } from "vue-router"
import router from "@lectorium/router/index.js"
import { useI18n } from "vue-i18n"
import { alertController } from "@ionic/vue"
import { useChatStore, type ChatMessage, type ChatSession } from "@lectorium/stores/useChatStore.js"
import { useToast } from "@kit/composables"
import { useTrackUserState } from "@lectorium/composables/useTrackUserState.js"
import { formatTimestamp } from "@lectorium/composables/formatTimestamp.js"
import { pauseGroup } from "@lectorium/composables/useAudioOrchestrator.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"

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
  /** True once the user DB has ≥1 listening_sessions row. Drives the
   *  "recap last lecture" suggestion chip on the empty state. */
  hasRecentListening: Ref<boolean>
  contentRef: Ref<HTMLElement | null>
  /** False while a session is loading + scroll-positioning. Bound to a
   *  visibility:hidden class on `.chat-scroll` so the user never sees
   *  the intermediate "messages at scrollTop=0" frame before
   *  scrollToBottom completes. */
  scrollReady: Ref<boolean>
  searchQuery: Ref<string>
  filteredSessions: Ref<ChatSession[]>
  /** Session ids with an unreplied agent-initiated message — passed to
   *  RecentSessions and ChatSessionList for the per-session dot marker. */
  unseenProactiveSessionIds: ComputedRef<ReadonlySet<string>>
  /** Set of focus message ids whose `/questions` round-trip is
   *  in-flight. Threaded into ChatMessageList so each focus card can
   *  show a "Picking questions…" placeholder until its chips land. */
  loadingFocusIds: ComputedRef<ReadonlySet<string>>
  /** Bibliographic header above the message list (derived from the
   *  first focus message in the session). `null` for free-form chats. */
  sessionHeader: ComputedRef<SessionHeaderInfo | null>
  /** Reactive ping the view watches to focus the textarea after the
   *  Ask-Sadhu navigation. */
  inputFocusToken: ComputedRef<number>
  /** True while the chat rate-limit window from the last 429 is still
   *  open. Drives the composer disabled state + "limit resets at HH:MM"
   *  placeholder so the user can't burn another quota-rejected send. */
  isComposeBlocked: ComputedRef<boolean>
  /** UnixMs deadline backing `isComposeBlocked`. Forwarded to the
   *  composer so the placeholder can show a wall-clock reset time. */
  composeBlockedUntil: ComputedRef<number | null>
  /** Per-day chat usage snapshot from the SSE `usage` event / 429 body.
   *  Forwarded to ChatInputBar which renders the chip above the
   *  composer when usage crosses the per-tier visibility threshold. */
  chatUsage: ComputedRef<{ current: number; limit: number; resetsAtEpoch: number } | null>
  onSend: (text: string) => Promise<void>
  /** User tapped the stop button while a turn was streaming. Aborts
   *  the SSE stream; the store's run loop preserves any partial
   *  assistant prose with `meta.error.kind="stopped"`. */
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

/**
 * View controller for ChatView. Owns the modal/state plumbing the
 * template needs and delegates persistence + streaming to the chat
 * store. Auto-scrolls to the bottom whenever the message list grows
 * (new user turn, streaming delta, finalised assistant message).
 */
export function useChatController(): ChatControllerReturn {
  const store = useChatStore()
  const player = usePlayerStore()
  // `useRoute()` is reactive (needed for the `?session=` query watcher
  //  below), but we add optional chains everywhere because the
  //  Vite-dev DI race + IonRouterOutlet quirks occasionally surface
  //  `undefined` here on first render. `router` uses the singleton
  //  import to avoid the same race for navigations.
  const route = useRoute()
  const { t } = useI18n()
  const toast = useToast()

  // The active session rides in `?session=<id>`. Reading it from a query
  // param (not a path param) is what keeps the chat screen on a single
  // stable pathname — see the route definition in `router/index.ts` for
  // why a path param would re-mount ChatView on every session open.
  function sessionIdFromRoute(): string | null {
    const q = route?.query?.session
    const id = Array.isArray(q) ? q[0] : q
    return typeof id === "string" && id.length > 0 ? id : null
  }

  const isHistoryOpen = ref(false)
  // The IonContent's inner scroller element — captured via template ref
  // on the wrapper div inside <ion-content> for auto-scroll-to-bottom.
  const contentRef = ref<HTMLElement | null>(null)

  // Visibility gate for `.chat-scroll`. Goes false while we're loading +
  // scroll-positioning a session, true once the scroll has actually
  // landed at the bottom. `IonContent.scrollToBottom` is async (awaits
  // `getScrollElement` internally + possibly a frame), so even with
  // `await nextTick(); await scrollToBottom()` the browser slips a
  // paint at scrollTop=0 into the await window. Hiding the scroller
  // via `visibility: hidden` (layout preserved, scrollHeight valid)
  // during that window prevents the user from ever seeing the wrong
  // frame. Defaults true so empty-state / chat-root renders instantly.
  const scrollReady = ref<boolean>(sessionIdFromRoute() === null)

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
    const sessionId = sessionIdFromRoute()
    if (sessionId !== null) {
      // Hide the scroller ONLY when we're swapping to a different
      // session — re-entering the same one doesn't need the blink.
      // We still run `openSession → nextTick → scrollToBottom` either
      // way: it's a no-op when the store + scroll are already current,
      // and it's what catches Ask Sadhu (added a focus message to the
      // already-active session before pushing the URL) so the new
      // message lands in view.
      const sameSession = store.activeSessionId === sessionId
      if (!sameSession) scrollReady.value = false
      // Anchor on the last message the user actually saw in this session.
      // Anything that arrived while they were away (a resumed answer, a
      // proactive reply) sits below it and reads downward from its start,
      // instead of the view snapping to the bottom past the beginning.
      // Read BEFORE openSession (the seen-tracking watcher updates it once
      // the messages load). Bottom when nothing newer arrived.
      const lastSeenId = await store.getLastSeenMessageId(sessionId)
      try {
        await store.openSession(sessionId)
        await nextTick()
        const last = store.messages[store.messages.length - 1]
        const anchor = lastSeenId && last && last.id !== lastSeenId ? lastSeenId : null
        if (anchor) scrollMessageToTop(anchor, "auto")
        else await scrollToBottom()
      } catch (err) {
        console.warn("chat: failed to open session", err)
        store.startNewSession()
      } finally {
        scrollReady.value = true
      }
    } else {
      // No `?session=` — we're on the empty chat home. Clear any
      // previously-loaded session so the view actually shows the
      // empty state. Without this, dropping the query (e.g. via the
      // chat-tab back-navigation or onNewSession) leaves the store
      // holding the old session's messages — URL says "chat root" but
      // ChatMessageList still renders the session's bubbles.
      // `startNewSession` is idempotent: cheap
      // no-op when the store is already empty (initial app mount),
      // an actual reset when coming from a session view.
      store.startNewSession()
      scrollReady.value = true
    }
  }

  async function onSend(text: string): Promise<void> {
    // Errors surface as inline failed-bubbles via `applyTurnEvent →
    // error` inside the store; no toast hop needed.
    await store.sendMessage(text)
  }

  function onCancel(): void {
    // Aborts the in-flight SSE stream. Any prose already streamed is
    // preserved by `runChatTurn`'s finalisation branch with
    // `meta.error.kind="stopped"`; if no text landed yet the
    // placeholder is dropped silently.
    store.cancelStream()
  }

  async function onRetry(messageId: string): Promise<void> {
    await store.retryLast(messageId)
  }

  function onNewSession(): void {
    store.startNewSession()
    if (sessionIdFromRoute() !== null) {
      void router.replace({ name: "chat", query: {} })
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
    // Picking a session from history used to load + scroll here AND again
    // via the route watcher that `router.replace` triggers below (double
    // open + double scroll). Now we only update the URL and let the single
    // `route.query.session` watcher run `ensureSessionFromRoute`
    // (open → scroll → reveal) — the same path deep-links and direct URLs
    // take. Hide the current content first so the old session's bubbles
    // don't linger for a frame before the swap.
    if (sessionIdFromRoute() === id) {
      // URL already points here — the watcher won't fire on an unchanged
      // query, so drive the (idempotent) open + scroll directly.
      await ensureSessionFromRoute()
      return
    }
    scrollReady.value = false
    void router.replace({ name: "chat", query: { session: id } })
  }

  async function onDeleteSession(id: string): Promise<void> {
    const wasActive = store.activeSessionId === id
    await store.deleteSession(id)
    if (wasActive && sessionIdFromRoute() !== null) {
      void router.replace({ name: "chat", query: {} })
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
                if (sessionIdFromRoute() !== null) {
                  void router.replace({ name: "chat", query: {} })
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

  /**
   * Empty-state suggestion pill tapped. Each tap spawns a brand-new
   * free-form session and dispatches the question immediately — the
   * user must NEVER see the prompt flash into the input bar.
   *
   * Single source of session creation: we just reset state and call
   * `sendMessage`, which calls `ensureActiveSession` once and writes
   * the row. The URL is synced afterwards by the `activeSessionId`
   * watcher below. The previous shape (pre-create here + sendMessage
   * re-calls `ensureActiveSession`) was ostensibly idempotent on the
   * second call, but any race that nulled `activeSessionId` between
   * the two awaits (route-watcher reset, re-mount during the Ionic
   * stack transition, anonymous→signed-in switch firing
   * `resetComposeLock` mid-await) produced a duplicate empty session
   * — and the user saw both in history.
   */
  async function onPickSuggestion(text: string): Promise<void> {
    store.startNewSession()
    void store.sendMessage(text)
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

  /**
   * Scroll a specific message's bubble to the top of the viewport. Used
   * to pin a freshly-sent user message in sight while the assistant
   * streams its reply below — the user wrote that question, so seeing
   * the question stay anchored is what they'd expect. We do NOT chase
   * the streaming reply downward; the user reads at their own pace.
   *
   * Uses the browser's native `scrollIntoView({ block: "start" })`
   * paired with `scroll-margin-top` on `.bubble-row` so the row lands
   * just below the fixed-top fade instead of under it — the CSS
   * variable handles the device-dependent offset (safe-area-top + the
   * button row height).
   */
  function scrollMessageToTop(messageId: string, behavior: ScrollBehavior = "smooth"): void {
    const el = contentRef.value
    if (!el) return
    const target = el.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`
    ) as HTMLElement | null
    if (!target) return
    target.scrollIntoView({ block: "start", behavior })
  }

  /**
   * Snap the scroll position to the bottom of the message list. Used
   * when a session is opened — same UX as every other chat app, the
   * user lands on the most recent turn instead of having to scroll
   * down themselves.
   *
   * Async because `IonContent.scrollToBottom()` awaits
   * `getScrollElement()` internally before applying
   * `scrollTop = scrollHeight`. Callers MUST `await` this.
   */
  async function scrollToBottom(durationMs = 0): Promise<void> {
    const el = contentRef.value
    if (!el) return
    const host = el.closest("ion-content") as
      | (HTMLElement & {
          scrollToBottom?: (durationMs: number) => Promise<void>
        })
      | null
    if (host && typeof host.scrollToBottom === "function") {
      await host.scrollToBottom(durationMs)
    } else {
      el.scrollTop = el.scrollHeight
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
  // Composite KEY (string) — Vue uses `===` to dedupe; a fresh
  // `{...}` literal returned from the getter would fail that check on
  // every reactive update and re-fire the scroll. The store replaces
  // `messages.value` immutably on every SSE event (status,
  // research_question, research_source, action, delta), so a
  // reference-comparing watcher was yanking the user back to the top
  // after every event — including when they had manually scrolled up
  // to re-read context mid-stream.
  watch(
    () => {
      const last = store.messages[store.messages.length - 1]
      if (!last) return ""
      // Only id/role/streaming gate the scroll — anything else on the
      // last message (statusKey, researchQuestions, actions, deltas)
      // is intentionally NOT in the key so it doesn't retrigger.
      return `${last.role}|${last.id}|${last.streaming ? "1" : "0"}`
    },
    async (key, prev) => {
      if (!key || key === prev) return
      // Re-read the last message off the live store — the key is just
      // a dedup signal, the full object lives in the reactive list.
      const last = store.messages[store.messages.length - 1]
      if (!last) return
      const isPlaceholder = last.role === "assistant" && last.streaming === true
      const isUserMessage = last.role === "user"
      if (!isUserMessage && !isPlaceholder) return
      await nextTick()
      // Wait for the browser to lay out before measuring offsetTop —
      // the placeholder's `min-height: calc(100svh - 200px)` only
      // takes effect after the next paint, and without that height
      // there isn't enough scroll room to pin the user message at
      // the top (the browser silently clamps scrollTop to the
      // max-reachable value, leaving the previous turn visible above).
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      // For the placeholder case the scroll target is the user
      // message right above it, not the placeholder itself. Walk
      // from the end to find the last user message in the list.
      const target = isUserMessage ? last.id : findLastUserMessageId(store.messages)
      if (target) scrollMessageToTop(target)
    }
  )

  // Remember the last message the user has seen in the open session, so
  // reopening it can anchor there (see `ensureSessionFromRoute`). Only
  // NON-streaming messages count: a streaming placeholder shares the final
  // answer's id, so if the user leaves mid-turn the last-seen id must stay
  // on the prior (fully-read) message, not jump to the not-yet-written
  // answer. While the session is on screen the watcher keeps the last-seen
  // id current; backgrounding freezes JS so it can't falsely mark unread
  // content as seen.
  watch(
    () => {
      const last = store.messages[store.messages.length - 1]
      if (!last || last.streaming) return ""
      return `${store.activeSessionId ?? ""}|${last.id}`
    },
    (key) => {
      if (!key) return
      const sid = store.activeSessionId
      if (!sid || sessionIdFromRoute() !== sid) return
      const last = store.messages[store.messages.length - 1]
      if (!last || last.streaming) return
      void store.markSessionSeen(sid, last.id)
    },
    { immediate: true }
  )

  watch(
    () => route?.query?.session,
    () => {
      // Stop any citation audio from the previous session — the chips
      // stay mounted across the in-screen query change (stable pathname,
      // no re-mount), so nothing else pauses them on switch. Only the
      // inline group — never the main lecture.
      pauseGroup("inline")
      void ensureSessionFromRoute()
    }
  )

  /**
   * URL sync — when `sendMessage` mints a session while the URL has no
   * `?session=` (pill tap or first-message direct-input send), promote
   * the URL to `?session=<id>` so the session has a shareable route,
   * history-back lands on the empty home, and deep-links round-trip.
   * The `!== id` guard makes this a no-op when the URL already reflects
   * the active session (e.g. after `onPickSession` replaced it), which
   * stops the route-watcher ↔ activeSessionId-watcher feedback loop
   * from re-firing. We can't navigate inside the store, and we don't
   * want to pre-create a session in the controller (the previous shape
   * did that and produced duplicates under racing awaits — see
   * `onPickSuggestion` above), so reacting to the store's own
   * activeSessionId is the cleanest path. Because session selection is
   * now a query change on a STABLE pathname, this `router.replace`
   * never re-mounts ChatView or triggers an Ionic page transition.
   */
  watch(
    () => store.activeSessionId,
    (id) => {
      if (id && sessionIdFromRoute() !== id) {
        void router.replace({ name: "chat", query: { session: id } })
      }
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

  const sessionHeader = computed<SessionHeaderInfo | null>(() => {
    // Pull bibliographic context from the FIRST focus message in the
    // session (its payload pinned title/author/date at insert time).
    // All focuses in a focused session belong to the same track and
    // share metadata — the first one is what gave the session its
    // identity.
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
    isHistoryOpen,
    hasMessages,
    hasCurrentTrack,
    hasRecentListening,
    contentRef,
    scrollReady,
    searchQuery,
    filteredSessions,
    unseenProactiveSessionIds: computed(() => store.unseenProactiveSessionIds),
    loadingFocusIds: computed(() => store.loadingFocusIds),
    sessionHeader,
    inputFocusToken: computed(() => store.inputFocusToken),
    isComposeBlocked: computed(() => store.isComposeBlocked),
    composeBlockedUntil: computed(() => store.composeBlockedUntil),
    chatUsage: computed(() => store.chatUsage),
    onSend,
    onCancel,
    onNewSession,
    onOpenHistory,
    onCloseHistory,
    onPickSession,
    onDeleteSession,
    onDeleteAllSessions,
    onPickChapter,
    onPickSuggestion,
    onRetry,
  }
}

import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from "vue"
import { useRoute } from "vue-router"
import router from "@shruti/router/index.js"
import { pauseGroup } from "@lib/chat/audio/useAudioOrchestrator.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import type { UseChatScrollReturn } from "./useChatScroll.js"

export interface UseChatSessionRouteReturn {
  /** The session in the URL, or null on the chat home. */
  sessionIdFromRoute: () => string | null
  /** Is chat the page on screen? */
  ownsRoute: ComputedRef<boolean>
  /** False while a session loads and positions itself, so the view can hide
   *  the scroller rather than paint a frame at scrollTop 0. */
  scrollReady: Ref<boolean>
  ensureSessionFromRoute: () => Promise<void>
}

/**
 * Binds the open session to `?session=<id>`.
 *
 * A query param, not a path param, is what keeps chat on one stable pathname:
 * a path param would re-mount the view on every session open.
 */
export function useChatSessionRoute(scroll: UseChatScrollReturn): UseChatSessionRouteReturn {
  const store = useChatStore()
  // `useRoute()` is reactive, which the query watcher needs, but the Vite-dev
  // DI race and IonRouterOutlet occasionally surface `undefined` here on first
  // render — hence the optional chains. Navigations use the router singleton.
  const route = useRoute()

  function sessionIdFromRoute(): string | null {
    const q = route?.query?.session
    const id = Array.isArray(q) ? q[0] : q
    return typeof id === "string" && id.length > 0 ? id : null
  }

  /**
   * Ionic keeps this view mounted after the user leaves the tab, and the route
   * a page reads is the global one. Without this, the watchers below would act
   * on navigations belonging to another page — rewriting the route under the
   * transcript dialog, or tearing the open session down on any hop off chat.
   *
   * Off-route means "not ours to touch", not "disabled": chat state is left
   * exactly as it was.
   */
  const ownsRoute = computed(() => String(router.currentRoute.value.name) === "chat")

  const scrollReady = ref<boolean>(sessionIdFromRoute() === null)

  async function openFromRoute(sessionId: string): Promise<void> {
    // Only blink the scroller when swapping sessions; re-entering the same one
    // still runs open → scroll, which is a no-op when both are current and is
    // what catches an Ask-Sadhu focus added before the URL changed.
    if (store.activeSessionId !== sessionId) scrollReady.value = false
    // Anchor on the last message the user actually saw. Read BEFORE
    // openSession, which updates it once the messages load.
    const lastSeenId = await store.getLastSeenMessageId(sessionId)
    try {
      await store.openSession(sessionId)
      await nextTick()
      const last = store.messages[store.messages.length - 1]
      const anchor = lastSeenId && last && last.id !== lastSeenId ? lastSeenId : null
      if (anchor) scroll.scrollMessageToTop(anchor, "auto")
      else await scroll.scrollToBottom()
    } catch (err) {
      console.warn("chat: failed to open session", err)
      store.startNewSession()
    } finally {
      scrollReady.value = true
    }
  }

  async function ensureSessionFromRoute(): Promise<void> {
    const sessionId = sessionIdFromRoute()
    if (sessionId !== null) {
      await openFromRoute(sessionId)
      return
    }
    // No `?session=`: the chat home. Clear the loaded session or the URL says
    // "root" while the list still renders the old bubbles. `startNewSession`
    // is idempotent.
    store.startNewSession()
    scrollReady.value = true
  }

  // The route name rides in the key alongside the query, so the sync resumes
  // the moment chat is back on screen. A composite string, because a fresh
  // object literal would fail Vue's dedup and re-open the session on every hop
  // between two other pages.
  watch(
    () => `${ownsRoute.value ? "1" : "0"}|${sessionIdFromRoute() ?? ""}`,
    () => {
      if (!ownsRoute.value) return
      // The chips stay mounted across an in-screen query change, so nothing
      // else stops the previous session's citation audio. Inline group only —
      // never the main lecture.
      pauseGroup("inline")
      void ensureSessionFromRoute()
    }
  )

  // Remember the last message seen in the open session so reopening can anchor
  // there. Only non-streaming messages count: a placeholder shares the final
  // answer's id, so leaving mid-turn must leave the mark on the prior message.
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

  /**
   * When `sendMessage` mints a session while the URL has none, promote the URL
   * so the session has a shareable route and history-back lands on the home.
   * The `!== id` guard keeps this a no-op once the URL already agrees, which
   * is what stops the two watchers from feeding each other.
   *
   * Only while chat is on screen: "Ask Sadhu" sets the active session from the
   * transcript dialog and navigates a few awaits later, and an unguarded
   * replace in that window rewrote the route the dialog was opened over.
   */
  watch(
    () => store.activeSessionId,
    (id) => {
      if (!ownsRoute.value) return
      if (id && sessionIdFromRoute() !== id) {
        void router.replace({ name: "chat", query: { session: id } })
      }
    }
  )

  return { sessionIdFromRoute, ownsRoute, scrollReady, ensureSessionFromRoute }
}

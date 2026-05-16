import { computed, nextTick, onMounted, ref, watch, type Ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import { useI18n } from "vue-i18n"
import { useChatStore, type ChatMessage, type ChatSession } from "@shruti/stores/useChatStore.js"
import { useToast } from "@shruti/services/useToast.js"

export interface ChatControllerReturn {
  messages: Ref<ChatMessage[]>
  sessions: Ref<ChatSession[]>
  activeSessionId: Ref<string | null>
  sending: Ref<boolean>
  isHistoryOpen: Ref<boolean>
  hasMessages: Ref<boolean>
  contentRef: Ref<HTMLElement | null>
  onSend: (text: string) => Promise<void>
  onNewSession: () => void
  onOpenHistory: () => Promise<void>
  onCloseHistory: () => void
  onPickSession: (id: string) => Promise<void>
  onDeleteSession: (id: string) => Promise<void>
}

/**
 * View controller for ChatView. Owns the modal/state plumbing the
 * template needs and delegates persistence + streaming to the chat
 * store. Auto-scrolls to the bottom whenever the message list grows
 * (new user turn, streaming delta, finalised assistant message).
 */
export function useChatController(): ChatControllerReturn {
  const store = useChatStore()
  const route = useRoute()
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()

  const isHistoryOpen = ref(false)
  // The IonContent's inner scroller element — captured via template ref
  // on the wrapper div inside <ion-content> for auto-scroll-to-bottom.
  const contentRef = ref<HTMLElement | null>(null)

  const hasMessages = computed(() => store.messages.length > 0)

  async function ensureSessionFromRoute(): Promise<void> {
    const param = route.params.sessionId
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
    if (route.name === "chat-session") {
      void router.replace({ name: "chat" })
    }
  }

  async function onOpenHistory(): Promise<void> {
    await store.refreshSessions()
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
    if (wasActive && route.name === "chat-session") {
      void router.replace({ name: "chat" })
    }
  }

  function surfaceError(): void {
    const err = store.lastError
    if (!err) return
    if (err.code === "rate_limited") {
      void toast.error(t("chat.errRate"))
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
    () => route.params.sessionId,
    () => {
      void ensureSessionFromRoute()
    }
  )

  onMounted(() => {
    void (async () => {
      await store.refreshSessions()
      await ensureSessionFromRoute()
    })()
  })

  return {
    messages: computed(() => [...store.messages]) as unknown as Ref<ChatMessage[]>,
    sessions: computed(() => [...store.sessions]) as unknown as Ref<ChatSession[]>,
    activeSessionId: computed(() => store.activeSessionId) as unknown as Ref<string | null>,
    sending: computed(() => store.sending) as unknown as Ref<boolean>,
    isHistoryOpen,
    hasMessages,
    contentRef,
    onSend,
    onNewSession,
    onOpenHistory,
    onCloseHistory,
    onPickSession,
    onDeleteSession,
  }
}

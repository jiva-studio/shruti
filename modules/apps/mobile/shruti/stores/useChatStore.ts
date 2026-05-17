import { defineStore } from "pinia"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import {
  useTrackUserState,
  type FocusFragmentPayload,
} from "@shruti/composables/useTrackUserState.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { useToast } from "@shruti/services/useToast.js"
import { parseChatMarkers } from "@shruti/views/Chat/composables/useMarkerParser.js"
import {
  addTracksToPlaylist,
  runChatTurn,
  saveChatNote,
  type RunChatTurnEvent,
} from "@lib/application"
import type {
  ChatActionPayload,
  ChatActionState,
  ChatMessage as DomainChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
  ChatSession as DomainChatSession,
} from "@lib/domain"
import type {
  ChatMessageId,
  ChatSessionId,
  TrackId,
} from "@lib/domain/core.js"
import {
  createHttpChatStreamClient,
} from "@infra/chat/httpChatStreamClient.js"
import {
  createHttpChatTitleService,
} from "@infra/chat/httpChatTitleService.js"
import {
  createSqlChatSessionRepository,
  createSqlChatMessageRepository,
} from "@infra/repositories/sql/index.js"
import { fetchSessionTitle } from "@shruti/services/chatClient.js"
import type { ChatTurn } from "@ports/app/index.js"

/* -------------------------------------------------------------------------- */
/*                                  Domain                                    */
/* -------------------------------------------------------------------------- */

// Re-export domain types so consumers can keep importing them from
// `@shruti/stores/useChatStore` (the legacy path) while the
// canonical declarations live in `@lib/domain`.
export type ChatSession = DomainChatSession
export type ChatMessage = DomainChatMessage & { streaming?: boolean }
export type ActionPayload = ChatActionPayload
export type OutlinePayload = ChatOutlinePayload
export type ActionState = ChatActionState
export type { ChatMessageError }

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function deriveTitle(text: string, max = 48): string {
  const trimmed = text.replace(/\s+/g, " ").trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max - 1).trimEnd() + "…"
}

/** chat_sessions.title_attempt_count semantics — see ChatSession docs.
 *  0 / 1..MAX: retry-eligible; MAX+1 = success or exhausted. */
const TITLE_MAX_ATTEMPTS = 3

/**
 * LLM occasionally writes `[action:create-playlist|id=X]` inline without
 * calling propose_playlist (a known DeepSeek failure mode). Salvage:
 * scan content for orphan markers and synthesize from sibling
 * `[card:track_id]` markers. Runs once on message finalisation.
 */
function salvageOrphanActions(
  content: string,
  existing: Record<string, ActionPayload>,
  fallbackName: string
): Record<string, ActionPayload> {
  const tokens = parseChatMarkers(content)
  const orphans = tokens
    .filter(
      (t): t is Extract<typeof t, { kind: "action" }> =>
        t.kind === "action" &&
        t.actionKind === "create_playlist" &&
        !existing[t.actionId]
    )
    .map((t) => t.actionId)
  if (orphans.length === 0) return existing
  const trackIds = tokens
    .filter((t): t is Extract<typeof t, { kind: "card" }> => t.kind === "card")
    .map((t) => t.trackId)
  if (trackIds.length === 0) return existing
  const out = { ...existing }
  for (const id of orphans) {
    out[id] = {
      kind: "create_playlist",
      id,
      name: fallbackName,
      trackIds,
    }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*                                   Store                                    */
/* -------------------------------------------------------------------------- */

/**
 * Owns the chat tab's reactive state and dispatches workflow verbs to
 * the use-cases in `@lib/application/chat`.
 *
 * The store does NOT touch SQL or HTTP directly — it constructs the
 * SQL repos + HTTP wrappers lazily from `useShruti()` and feeds them
 * into use-cases. This keeps the layering rule satisfied (presentation
 * → use-case → repo/service ports) and makes `sendMessage` testable by
 * stubbing `runChatTurn`.
 */
export const useChatStore = defineStore("chat", () => {
  const app = useShruti()
  const appLanguage = useAppLanguage()
  const trackUserState = useTrackUserState()
  const playlist = usePlaylistStore()
  const notes = useNotesStore()
  const toast = useToast()
  const { t } = useI18n()

  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const sending = ref<boolean>(false)
  const lastError = ref<{ code: string; message: string; retryAfter?: number } | null>(null)

  let abort: AbortController | null = null

  function userDb() {
    const db = app.databases.user
    if (!db) throw new Error("chat-store: user DB is not open yet")
    return db
  }

  function chatRepos() {
    const userDatabase = userDb()
    return {
      sessions: createSqlChatSessionRepository(userDatabase),
      messages: createSqlChatMessageRepository(userDatabase),
    }
  }

  function streamClient() {
    return createHttpChatStreamClient()
  }
  function titleService() {
    return createHttpChatTitleService()
  }

  async function refreshSessions(): Promise<void> {
    const repos = chatRepos()
    const rows = await repos.sessions.list(200)
    sessions.value = rows.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      titleAttemptCount: s.titleAttemptCount,
    }))
  }

  async function openSession(id: string): Promise<void> {
    activeSessionId.value = id
    const repos = chatRepos()
    const rows = await repos.messages.listBySession(id as ChatSessionId)
    messages.value = rows.map((m) => ({ ...m }))
  }

  function startNewSession(): void {
    if (sending.value) cancelStream()
    activeSessionId.value = null
    messages.value = []
    lastError.value = null
  }

  async function ensureActiveSession(seedTitle: string): Promise<string> {
    if (activeSessionId.value) return activeSessionId.value
    const repos = chatRepos()
    const id = randomId() as ChatSessionId
    const created = await repos.sessions.create({ id, title: deriveTitle(seedTitle) })
    activeSessionId.value = id
    sessions.value = [created, ...sessions.value]
    return id
  }

  async function sendMessage(
    text: string,
    options?: { focus?: FocusFragmentPayload }
  ): Promise<void> {
    const clean = text.trim()
    if (!clean || sending.value) return
    lastError.value = null
    sending.value = true

    const sessionId = (await ensureActiveSession(clean)) as ChatSessionId
    abort = new AbortController()
    const repos = chatRepos()

    // Snapshot history BEFORE we add the new turn so the server doesn't
    // see its own optimistic placeholder.
    const lang: "ru" | "en" = appLanguage.value.startsWith("en") ? "en" : "ru"
    const history: ChatTurn[] = messages.value
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }))

    let assistantMsgId: ChatMessageId | null = null
    let acc = ""

    try {
      const isFirst =
        messages.value.filter((m) => m.role === "assistant" && !m.streaming).length === 0
      for await (const event of runChatTurn(
        {
          sessionId,
          text: clean,
          lang,
          history,
          focus: options?.focus,
          isFirstAssistantTurn: isFirst,
          newMessageId: () => randomId() as ChatMessageId,
          signal: abort.signal,
        },
        {
          sessions: repos.sessions,
          messages: repos.messages,
          stream: streamClient(),
          title: titleService(),
          buildUserContext: (focus) => trackUserState.buildUserContext(focus),
          salvageOrphanActions,
          fallbackPlaylistName: t("chat.fallbackPlaylistName"),
        }
      )) {
        applyTurnEvent(event)
        if (event.kind === "user-message") {
          // session list re-order
          const idx = sessions.value.findIndex((s) => s.id === sessionId)
          if (idx >= 0) {
            const updated = { ...sessions.value[idx], updatedAt: Date.now() }
            sessions.value = [updated, ...sessions.value.filter((_, i) => i !== idx)]
          }
        }
        if (event.kind === "assistant-placeholder") assistantMsgId = event.messageId
        if (event.kind === "delta") acc += event.text
        if (event.kind === "tool-start") acc = ""
      }
    } catch (err) {
      lastError.value = {
        code: "stream",
        message: err instanceof Error ? err.message : "Stream failed",
      }
    } finally {
      abort = null
      sending.value = false
      // If the assistant bubble was never finalised (e.g. abort mid-stream),
      // drop the streaming placeholder so the UI doesn't keep its spinner.
      if (assistantMsgId) {
        const idx = messages.value.findIndex((m) => m.id === assistantMsgId)
        if (idx >= 0 && messages.value[idx].streaming) {
          if (acc.length === 0) {
            messages.value = messages.value.filter((m) => m.id !== assistantMsgId)
          }
        }
      }
    }
  }

  function applyTurnEvent(event: RunChatTurnEvent): void {
    switch (event.kind) {
      case "user-message":
        messages.value = [...messages.value, event.message]
        return
      case "assistant-placeholder": {
        const placeholder: ChatMessage = {
          id: event.messageId,
          sessionId: (activeSessionId.value ?? "") as ChatSessionId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          streaming: true,
        }
        messages.value = [...messages.value, placeholder]
        return
      }
      case "delta": {
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        next[idx] = { ...next[idx], content: next[idx].content + event.text }
        messages.value = next
        return
      }
      case "tool-start": {
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        next[idx] = { ...next[idx], content: "" }
        messages.value = next
        return
      }
      case "action": {
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        const cur = next[idx]
        next[idx] = {
          ...cur,
          actions: { ...(cur.actions ?? {}), [event.actionId]: event.payload },
        }
        messages.value = next
        return
      }
      case "outline": {
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        const cur = next[idx]
        next[idx] = {
          ...cur,
          outlines: { ...(cur.outlines ?? {}), [event.trackId]: event.payload },
        }
        messages.value = next
        return
      }
      case "finalised": {
        // Replace the streaming placeholder with the persisted entity.
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) {
          messages.value = [...messages.value, { ...event.message }]
          return
        }
        const next = [...messages.value]
        next[idx] = { ...event.message }
        messages.value = next
        return
      }
      case "title-updated": {
        const sid = activeSessionId.value
        if (!sid) return
        const i = sessions.value.findIndex((s) => s.id === sid)
        if (i < 0) return
        const next = [...sessions.value]
        next[i] = { ...next[i], title: event.title }
        sessions.value = next
        return
      }
      case "error": {
        lastError.value = {
          code: event.code,
          message: event.message,
          retryAfter: event.retryAfter,
        }
        // Drop the empty placeholder — the toast / banner conveys failure.
        messages.value = messages.value.filter((m) => !m.streaming)
        return
      }
    }
  }

  function cancelStream(): void {
    if (abort) abort.abort()
    abort = null
  }

  async function setActionState(
    messageId: string,
    actionId: string,
    state: ActionState
  ): Promise<void> {
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const prev = messages.value[idx]
    const actionStates = { ...(prev.actionStates ?? {}), [actionId]: state }
    const next = [...messages.value]
    next[idx] = { ...prev, actionStates }
    messages.value = next
    try {
      await chatRepos().messages.updateActionStates(messageId as ChatMessageId, actionStates)
    } catch (err) {
      console.warn("chat: failed to persist action state", err)
    }
  }

  async function executeAction(messageId: string, actionId: string): Promise<void> {
    const msg = messages.value.find((m) => m.id === messageId)
    if (!msg) return
    const action = msg.actions?.[actionId]
    if (!action) return
    const currentState = msg.actionStates?.[actionId] ?? "pending"
    if (currentState === "executing" || currentState === "done") return

    await setActionState(messageId, actionId, "executing")
    try {
      if (action.kind === "create_playlist") {
        const r = await addTracksToPlaylist(
          { trackIds: action.trackIds as readonly TrackId[] },
          {
            playlist: {
              add: (id) =>
                playlist.add(id as TrackId) as unknown as Promise<unknown>,
            },
          }
        )
        if (!r.ok) throw new Error(`add to playlist failed: ${r.error}`)
      } else if (action.kind === "save_note") {
        const r = await saveChatNote(
          {
            trackId: action.trackId as TrackId,
            text: action.text,
            startMs: action.startMs,
            endMs: action.endMs,
            chatActionId: actionId,
          },
          { notes: app.repositories().notes }
        )
        if (!r.ok) throw new Error(`save chat note failed: ${r.error}`)
        await notes.refresh()
        await toast.info(t("chat.noteSaved"))
      }
      await setActionState(messageId, actionId, "done")
    } catch (err) {
      console.warn("chat: action execution failed", err)
      await setActionState(messageId, actionId, "error")
    }
  }

  async function deleteSession(id: string): Promise<void> {
    const repos = chatRepos()
    await repos.messages.deleteBySession(id as ChatSessionId)
    await repos.sessions.delete(id as ChatSessionId)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeSessionId.value === id) {
      activeSessionId.value = null
      messages.value = []
    }
  }

  async function clearAll(): Promise<void> {
    // Stop any in-flight SSE stream first — otherwise the streaming
    // finally-block would persist its accumulated reply into the
    // freshly-emptied tables, leaving an orphan row.
    cancelStream()
    const repos = chatRepos()
    await repos.messages.clearAll()
    await repos.sessions.clearAll()
    sessions.value = []
    activeSessionId.value = null
    messages.value = []
  }

  /**
   * Case-insensitive title-only search over the loaded sessions list.
   * Runs in JS because SQLite's `LOWER()` / `LIKE` only fold ASCII and
   * would silently miss Cyrillic uppercase ("Сколько" vs "сколько").
   * Session list is capped at 200 by `refreshSessions`, so a linear
   * scan per keystroke is trivial.
   */
  function searchSessions(query: string): ChatSession[] {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return sessions.value.slice()
    return sessions.value.filter((s) => (s.title ?? "").toLowerCase().includes(needle))
  }

  /**
   * Foreground worker — re-attempts `/title` for sessions whose initial
   * call returned null. Bounded by attempt-count and a 7-day window.
   * The chat client's null-on-failure semantics (added in 3.6) make
   * this safe to call freely on app resume / view mount.
   */
  async function retryPendingTitles(lang: "ru" | "en"): Promise<void> {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const repos = chatRepos()
    const all = await repos.sessions.list(200)
    const candidates = all.filter(
      (s) =>
        s.titleAttemptCount >= 1 &&
        s.titleAttemptCount <= TITLE_MAX_ATTEMPTS &&
        s.createdAt > sevenDaysAgo
    )
    for (const session of candidates.slice(0, 10)) {
      const rows = await repos.messages.listBySession(session.id)
      const turns: ChatTurn[] = rows
        .filter((r) => r.role === "user" || r.role === "assistant")
        .slice(0, 4)
        .map((r) => ({ role: r.role, content: r.content }))
      if (turns.length === 0) continue
      const newTitle = await fetchSessionTitle(turns, lang)
      if (newTitle) {
        await repos.sessions.updateTitle(session.id, newTitle)
        const idx = sessions.value.findIndex((s) => s.id === session.id)
        if (idx >= 0) {
          const next = [...sessions.value]
          next[idx] = { ...next[idx], title: newTitle }
          sessions.value = next
        }
      } else {
        await repos.sessions.incrementTitleAttempt(session.id)
      }
    }
  }

  return {
    sessions,
    activeSessionId,
    messages,
    sending,
    lastError,
    refreshSessions,
    openSession,
    startNewSession,
    sendMessage,
    cancelStream,
    executeAction,
    deleteSession,
    clearAll,
    searchSessions,
    retryPendingTitles,
  }
})

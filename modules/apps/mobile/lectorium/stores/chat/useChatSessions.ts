import { computed, type ComputedRef, type Ref } from "vue"
import type { ChatFocusPayload } from "@lib/domain"
import type { ChatMessageId, ChatSessionId, TrackId } from "@lib/domain/core.js"
import type {
  IChatMessageRepository,
  IChatSessionRepository,
  IProactiveStateRepository,
} from "@lib/domain/ports/index.js"
import type { PendingTurn } from "@lectorium/stores/chatPendingTurns.js"
import type { ChatMessage, ChatSession } from "./chatTypes.js"
import { ensureThinkingPlaceholder, randomId, type StreamTarget } from "./chatBubbles.js"
import type { ChatReadState } from "./useChatReadState.js"

export interface ChatSessionsDeps {
  sessions: Ref<ChatSession[]>
  activeSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  sending: Ref<boolean>
  chatRepos: () => { sessions: IChatSessionRepository; messages: IChatMessageRepository }
  proactiveState: () => IProactiveStateRepository
  readState: ChatReadState
  readPending: () => Promise<PendingTurn[]>
  /** Sessions with a live stream, and the target each live fold owns. */
  turnControllers: Map<string, AbortController>
  liveTargets: Map<string, StreamTarget>
  resumeOnePendingTurn: (entry: PendingTurn) => Promise<void>
  cancelSuggestions: () => void
  syncComposeBusy: () => void
}

export interface ChatSessions {
  activeSession: ComputedRef<ChatSession | null>
  sessionTitleFor: (sessionId: string) => string | null
  refreshSessions: () => Promise<void>
  openSession: (id: string) => Promise<void>
  startNewSession: () => void
  openOrCreateFocusedSession: (trackId: TrackId) => Promise<ChatSessionId>
  appendFocusMessage: (focus: ChatFocusPayload) => Promise<ChatMessageId>
  ensureActiveSession: (seedTitle: string) => Promise<string>
  /** Re-sorts the history list after a session gains a message. */
  moveSessionToTop: (sessionId: string, updatedAt: number) => void
  searchSessions: (query: string) => ChatSession[]
}

function deriveTitle(text: string, max = 48): string {
  const trimmed = text.replace(/\s+/g, " ").trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max - 1).trimEnd() + "…"
}

/** The conversation list and which one is open. */
export function useChatSessions(deps: ChatSessionsDeps): ChatSessions {
  const { sessions, activeSessionId, messages, sending, readState, turnControllers, liveTargets } =
    deps

  const activeSession = computed<ChatSession | null>(() => {
    const id = activeSessionId.value
    if (!id) return null
    return sessions.value.find((s) => s.id === id) ?? null
  })

  /** Labels "answer ready" notifications; null when the session has no title yet. */
  function sessionTitleFor(sessionId: string): string | null {
    const title = sessions.value.find((s) => s.id === sessionId)?.title?.trim()
    return title ? title : null
  }

  async function refreshSessions(): Promise<void> {
    const rows = await deps.chatRepos().sessions.list(200)
    sessions.value = rows.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
    // Best-effort: if the proactive repo isn't ready, keep the previous set
    // rather than throw out of a sessions refresh.
    try {
      const ids = await deps.proactiveState().listUnseenSessionIds()
      await readState.refreshUnseen(ids, new Set(sessions.value.map((s) => s.id)))
    } catch {
      // proactiveState repo not ready — refreshSessions catches up later.
    }
  }

  /**
   * Switching away from a session mid-stream DETACHES its turn rather than
   * aborting it: the turn keeps streaming and persists its reply to its own
   * session. The Stop button is the only explicit abort.
   */
  async function openSession(id: string): Promise<void> {
    // The "Ask Sadhu" flow navigates after opening, and the router watcher
    // re-fires this for the same id; without the guard that second call would
    // abort the in-flight suggestions and reload the list for nothing.
    if (activeSessionId.value === id) return
    deps.cancelSuggestions()
    activeSessionId.value = id
    deps.syncComposeBusy()
    const rows = await deps.chatRepos().messages.listBySession(id as ChatSessionId)
    messages.value = rows.map((m) => ({ ...m }))
    await raiseInflightPlaceholder(id)
    markSeen(id)
  }

  /**
   * A turn for this session may still be in flight — its live stream kept
   * running after a navigation, or it is resuming after a background. Raising
   * the bubble is a view operation: a live stream gets its own target handed
   * back, otherwise the resume poll mints one and claims it.
   */
  async function raiseInflightPlaceholder(id: string): Promise<void> {
    const inflight = (await deps.readPending()).find((p) => p.sessionId === id)
    if (!inflight) return
    ensureThinkingPlaceholder(messages, id, inflight.assistantMessageId, liveTargets.get(id))
    if (!turnControllers.has(id)) void deps.resumeOnePendingTurn(inflight)
  }

  /**
   * Opening a session counts as having seen its proactive messages. The
   * in-memory set clears the dot instantly; the SQL stamp is off the critical
   * path because it only needs to survive a reload.
   */
  function markSeen(id: string): void {
    readState.forgetUnseen(id)
    void readState.clearAnswerUnread(id)
    void deps
      .proactiveState()
      .markSeen(id as ChatSessionId, Math.floor(Date.now() / 1000))
      .catch(() => {
        // proactiveState repo not ready — refreshSessions catches up.
      })
  }

  /** Detaches any in-flight turn rather than aborting it; starting a fresh chat clears the view. */
  function startNewSession(): void {
    deps.cancelSuggestions()
    activeSessionId.value = null
    messages.value = []
    sending.value = false
  }

  /**
   * "Ask Sadhu": open the latest session anchored to `trackId`, or create one.
   * Several taps from the same track accumulate focus messages in ONE session
   * instead of spawning a duplicate per fragment.
   */
  async function openOrCreateFocusedSession(trackId: TrackId): Promise<ChatSessionId> {
    deps.cancelSuggestions()
    const repos = deps.chatRepos()
    const existing = await repos.sessions.findLatestByTrack(trackId)
    if (existing) {
      await openSession(existing.id)
      return existing.id as ChatSessionId
    }
    const id = randomId() as ChatSessionId
    const created = await repos.sessions.create({ id, title: null, trackId })
    activeSessionId.value = id
    messages.value = []
    sessions.value = [created, ...sessions.value.filter((s) => s.id !== id)]
    deps.syncComposeBusy()
    return id
  }

  /**
   * Append a focus-marked user message: a normal history turn to the server,
   * drawn as the full-width focus card by the bubble renderer. NOT a chat turn
   * — the caller dispatches `requestSuggestions` separately if it wants chips.
   */
  async function appendFocusMessage(focus: ChatFocusPayload): Promise<ChatMessageId> {
    const sessionId = activeSessionId.value
    if (!sessionId) {
      throw new Error(
        "appendFocusMessage: no active session — call openOrCreateFocusedSession first"
      )
    }
    const repos = deps.chatRepos()
    const id = randomId() as ChatMessageId
    const createdAt = Date.now()
    const persisted = await repos.messages.create({
      id,
      sessionId: sessionId as ChatSessionId,
      role: "user",
      content: focus.text,
      createdAt,
      focus,
    })
    await repos.sessions.touch(sessionId as ChatSessionId, createdAt)
    moveSessionToTop(sessionId, createdAt)
    messages.value = [...messages.value, { ...persisted }]
    return id
  }

  function moveSessionToTop(sessionId: string, updatedAt: number): void {
    const idx = sessions.value.findIndex((s) => s.id === sessionId)
    if (idx < 0) return
    const updated = { ...sessions.value[idx], updatedAt }
    sessions.value = [updated, ...sessions.value.filter((_, i) => i !== idx)]
  }

  async function ensureActiveSession(seedTitle: string): Promise<string> {
    if (activeSessionId.value) return activeSessionId.value
    const id = randomId() as ChatSessionId
    const created = await deps.chatRepos().sessions.create({ id, title: deriveTitle(seedTitle) })
    activeSessionId.value = id
    sessions.value = [created, ...sessions.value]
    return id
  }

  function searchSessions(query: string): ChatSession[] {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return sessions.value.slice()
    return sessions.value.filter((s) => (s.title ?? "").toLowerCase().includes(needle))
  }

  return {
    activeSession,
    sessionTitleFor,
    refreshSessions,
    openSession,
    startNewSession,
    openOrCreateFocusedSession,
    appendFocusMessage,
    ensureActiveSession,
    moveSessionToTop,
    searchSessions,
  }
}

import type { Ref } from "vue"
import type { PendingTurn } from "@shruti/stores/chatPendingTurns.js"
import type { ChatUseCases } from "@shruti/wiring/chatUseCases.js"
import type { ChatMessage, ChatSession } from "@usecases/chat/chatThread.js"
import type { ChatReadState } from "./useChatReadState.js"
import type { ChatStreams } from "./useChatStreams.js"
import { useChatCleanup, type ChatCleanup } from "./useChatCleanup.js"
import { useChatSessions, type ChatSessions } from "./useChatSessions.js"

export interface ChatThreads {
  readonly list: ChatSessions
  readonly cleanup: ChatCleanup
}

/** The conversation list, which one is open, and removing them. */
export function useChatThreads(deps: {
  sessions: Ref<ChatSession[]>
  activeSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  sending: Ref<boolean>
  chat: ChatUseCases
  readState: ChatReadState
  readPending: () => Promise<PendingTurn[]>
  clearPendingRecords: () => Promise<void>
  streams: ChatStreams
  /** Late-bound: the turn controller is built after the threads. */
  resumeOnePendingTurn: (entry: PendingTurn) => Promise<void>
  cancelSuggestions: () => void
}): ChatThreads {
  const { sessions, activeSessionId, messages, chat, readState, readPending, streams } = deps
  const list = useChatSessions({
    sessions,
    activeSessionId,
    messages,
    sending: deps.sending,
    chatRepos: chat.threads,
    proactiveState: chat.proactiveState,
    readState,
    readPending,
    turnControllers: streams.turnControllers,
    liveTargets: streams.liveTargets,
    resumeOnePendingTurn: deps.resumeOnePendingTurn,
    cancelSuggestions: deps.cancelSuggestions,
    syncComposeBusy: streams.syncComposeBusy,
  })
  const cleanup = useChatCleanup({
    sessions,
    activeSessionId,
    messages,
    deleteSessionRecords: chat.deleteSession,
    clearAllRecords: chat.clearHistory,
    readState,
    readPending,
    clearPendingRecords: deps.clearPendingRecords,
    cancelAllStreams: streams.cancelAllStreams,
    cancelSuggestions: deps.cancelSuggestions,
  })
  return { list, cleanup }
}

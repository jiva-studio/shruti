import { defineStore } from "pinia"
import { ref } from "vue"
import { useToast } from "@kit/composables"
import { i18n } from "@shruti/i18n/index.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useChatLanguage, useChatTranslateCitations } from "@shruti/composables/useChatLanguage.js"
import { useTrackUserState } from "@shruti/composables/useTrackUserState.js"
import { useChatComposePolicy } from "@shruti/stores/chat/useChatComposePolicy.js"
import { useChatReadState } from "@shruti/stores/chat/useChatReadState.js"
import { useChatStreams } from "@shruti/stores/chat/useChatStreams.js"
import { useChatThreads } from "@shruti/stores/chat/useChatThreads.js"
import { useChatTurnController } from "@shruti/stores/chat/useChatTurnController.js"
import { createPendingTurnStore } from "@shruti/stores/chatPendingTurns.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useAddLibraryItem } from "@shruti/wiring/addLibraryItem.js"
import { useChatUseCases } from "@shruti/wiring/chatUseCases.js"
import type { ChatMessage, ChatSession } from "@usecases/chat/chatThread.js"

// Re-exported so consumers can keep importing these from the store path while
// the declarations live beside the chat use cases.
export type {
  ActionPayload,
  ActionState,
  ChatMessage,
  ChatResearchSource,
  ChatSession,
  ChatStatusParams,
  OutlinePayload,
} from "@usecases/chat/chatThread.js"
export type { ChatMessageError } from "@lib/domain"

/**
 * The chat tab: the thread on screen, and three parts that act on it — the
 * conversation list (`useChatThreads`), one turn from question to answer
 * (`useChatTurnController`) and when the composer may send
 * (`useChatComposePolicy`). This composes them and exposes the surface the
 * views consume; the ports come bound from `shruti/wiring`.
 */
export const useChatStore = defineStore("chat", () => {
  const app = useShruti()
  const chat = useChatUseCases()
  const appLanguage = useAppLanguage()
  const chatLanguage = useChatLanguage()
  const chatTranslateCitations = useChatTranslateCitations()
  const trackUserState = useTrackUserState()
  const playlist = usePlaylistStore()
  // The global translator: a store outlives the component that first used it and
  // may be created outside any setup(), where useI18n() has no instance to bind to.
  const t = (key: string): string => i18n.global.t(key)
  const toast = useToast()
  const lang = (): string => chatLanguage.value || appLanguage.value

  const messages = ref<ChatMessage[]>([])
  const sending = ref<boolean>(false)
  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const readState = useChatReadState(app.preferences)

  // One record per in-flight turn, persisted so it survives an app kill: on
  // return the server is polled and the buffered events replayed through the
  // same fold, so a turn interrupted mid-answer is rebuilt rather than lost.
  const pendingTurns = createPendingTurnStore(app.preferences)

  const streams = useChatStreams({
    activeSessionId,
    sending,
    resumeService: () => app.chatResumeService,
    removePending: pendingTurns.remove,
  })
  const compose = useChatComposePolicy({
    preferences: app.preferences,
    messages,
    sending,
    retryLast: (messageId) => turns.retry.retryLast(messageId),
  })
  const threads = useChatThreads({
    sessions,
    activeSessionId,
    messages,
    sending,
    chat,
    readState,
    readPending: pendingTurns.read,
    clearPendingRecords: pendingTurns.clear,
    streams,
    resumeOnePendingTurn: (entry) => turns.resume.resumeOnePendingTurn(entry),
    cancelSuggestions: () => turns.suggestions.cancelSuggestions(),
  })
  const turns = useChatTurnController({
    messages,
    sending,
    sessions,
    activeSessionId,
    chat,
    streams,
    compose,
    threads,
    readPending: pendingTurns.read,
    addPending: pendingTurns.add,
    removePending: pendingTurns.remove,
    services: {
      stream: () => app.chatStreamClient,
      title: () => app.chatTitleService,
      questions: () => app.chatQuestionsService,
      feedback: () => app.chatFeedbackService,
      resume: () => app.chatResumeService,
    },
    notifications: app.notifications,
    buildUserContext: (focus) => trackUserState.buildUserContext(focus),
    addToQueue: (trackId) => playlist.add(trackId),
    addToLibrary: (url, hints) => useAddLibraryItem()(url, hints),
    lang,
    translateCitations: () => chatTranslateCitations.value,
    toastError: (message) => void toast.error(message),
    t,
  })

  return {
    sessions,
    activeSession: threads.list.activeSession,
    activeSessionId,
    messages,
    sending,
    resumePendingTurns: turns.resume.resumePendingTurns,
    listPendingTurns: pendingTurns.read,
    clearPendingTurns: threads.cleanup.clearPendingTurns,
    sessionTitleFor: threads.list.sessionTitleFor,
    markAnswerUnread: readState.markAnswerUnread,
    getLastSeenMessageId: readState.getLastSeenMessageId,
    markSessionSeen: readState.markSessionSeen,
    loadingFocusIds: turns.suggestions.loadingFocusIds,
    inputFocusToken: turns.suggestions.inputFocusToken,
    composeBlockedUntil: compose.composeLock.composeBlockedUntil,
    isComposeBlocked: compose.composeLock.isComposeBlocked,
    resetComposeLock: compose.composeLock.resetComposeLock,
    chatUsage: compose.usage.snapshot,
    /** Sessions carrying an unseen proactive row or an answer that landed while
     *  the user was away — the per-session dot and the tab-level Sadhu badge. */
    unseenProactiveSessionIds: readState.unseenSessionIds,
    refreshSessions: threads.list.refreshSessions,
    openSession: threads.list.openSession,
    openOrCreateFocusedSession: threads.list.openOrCreateFocusedSession,
    appendFocusMessage: threads.list.appendFocusMessage,
    requestSuggestions: turns.suggestions.requestSuggestions,
    requestInputFocus: turns.suggestions.requestInputFocus,
    startNewSession: threads.list.startNewSession,
    ensureActiveSession: threads.list.ensureActiveSession,
    sendMessage: turns.sendMessage,
    cancelStream: streams.cancelStream,
    retryLast: turns.retry.retryLast,
    executeAction: turns.actions.executeAction,
    deleteSession: threads.cleanup.deleteSession,
    clearAll: threads.cleanup.clearAll,
    searchSessions: threads.list.searchSessions,
    submitFeedback: turns.submitFeedback,
  }
})

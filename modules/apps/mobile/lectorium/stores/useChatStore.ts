import { defineStore } from "pinia"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { useChatComposeLock } from "@lectorium/stores/chat/useChatComposeLock.js"
import { useChatUsageChip } from "@lectorium/stores/chat/useChatUsageChip.js"
import { createChatTurnFold } from "@lectorium/stores/chat/useChatTurnFold.js"
import { useChatResume } from "@lectorium/stores/chat/useChatResume.js"
import { useChatActions } from "@lectorium/stores/chat/useChatActions.js"
import { useChatSuggestions } from "@lectorium/stores/chat/useChatSuggestions.js"
import { useChatSessions } from "@lectorium/stores/chat/useChatSessions.js"
import { useChatLiveTurn } from "@lectorium/stores/chat/useChatLiveTurn.js"
import { useChatStreams } from "@lectorium/stores/chat/useChatStreams.js"
import { useChatRetry } from "@lectorium/stores/chat/useChatRetry.js"
import { useChatCleanup } from "@lectorium/stores/chat/useChatCleanup.js"
import { submitFeedback, type ChatFeedbackInput } from "@lectorium/stores/chat/useChatFeedback.js"
import type { ChatMessageId } from "@lib/domain/core.js"
import { useChatReadState } from "@lectorium/stores/chat/useChatReadState.js"
import type { ChatMessage, ChatSession } from "@lectorium/stores/chat/chatTypes.js"
import { createPendingTurnStore } from "@lectorium/stores/chatPendingTurns.js"
import { useToast } from "@kit/composables"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import {
  useChatLanguage,
  useChatTranslateCitations,
} from "@lectorium/composables/useChatLanguage.js"
import { useTrackUserState } from "@lectorium/composables/useTrackUserState.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"

// Re-exported so consumers can keep importing these from the store path while
// the declarations live beside the rest of the chat modules.
export type {
  ActionPayload,
  ActionState,
  ChatMessage,
  ChatResearchSource,
  ChatSession,
  ChatStatusParams,
  OutlinePayload,
} from "./chat/chatTypes.js"
export type { ChatMessageError } from "@lib/domain"

/* -------------------------------------------------------------------------- */
/*                                   Store                                    */
/* -------------------------------------------------------------------------- */

/**
 * Composes the chat tab: each responsibility lives in `./chat/`, and the store
 * wires them together and exposes the surface the views consume.
 *
 * It touches neither SQL nor HTTP — the repositories and service adapters come
 * off `useLectorium()`, which keeps the layering rule (presentation →
 * use-case → repo/service ports) satisfied.
 */
export const useChatStore = defineStore("chat", () => {
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const chatLanguage = useChatLanguage()
  const chatTranslateCitations = useChatTranslateCitations()
  const trackUserState = useTrackUserState()
  const playlist = usePlaylistStore()
  const { t } = useI18n()
  const toast = useToast()

  const messages = ref<ChatMessage[]>([])
  const sending = ref<boolean>(false)
  const readState = useChatReadState(app.preferences)
  /** Sessions carrying an unseen proactive row or an answer that landed while
   *  the user was away — the per-session dot and the tab-level Sadhu badge. */
  const unseenProactiveSessionIds = readState.unseenSessionIds
  // The repositories and service adapters are built by the composition root;
  // the store only consumes them and never instantiates an @infra adapter.
  function chatRepos() {
    const repos = app.repositories()
    return { sessions: repos.chatSessions, messages: repos.chatMessages, now: Date.now }
  }
  const resumeService = (): typeof app.chatResumeService => app.chatResumeService

  // One record per in-flight turn, persisted so it survives an app kill: on
  // return the server is polled and the buffered events replayed through the
  // same fold, so a turn interrupted mid-answer is rebuilt rather than lost.
  const pendingTurns = createPendingTurnStore(app.preferences)
  const readPending = pendingTurns.read
  const addPending = pendingTurns.add
  const removePending = pendingTurns.remove

  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const { turnControllers, liveTargets, cancelStream, cancelAllStreams, syncComposeBusy } =
    useChatStreams({ activeSessionId, sending, resumeService, removePending })

  const usage = useChatUsageChip(app.preferences)
  const composeLock = useChatComposeLock({
    usage,
    messages,
    sending,
    retryLast: (messageId) => retry.retryLast(messageId),
  })
  const { composeBlockedUntil, isComposeBlocked } = composeLock
  const sessionList = useChatSessions({
    sessions,
    activeSessionId,
    messages,
    sending,
    chatRepos,
    proactiveState: () => app.repositories().proactiveState,
    readState,
    readPending,
    turnControllers,
    liveTargets,
    resumeOnePendingTurn: (entry) => resumeOnePendingTurn(entry),
    cancelSuggestions: () => suggestions.cancelSuggestions(),
    syncComposeBusy,
  })
  const suggestions = useChatSuggestions({
    messages,
    activeSessionId,
    chatMessages: () => chatRepos().messages,
    questionsService: () => app.chatQuestionsService,
    lang: () => chatLanguage.value || appLanguage.value,
  })
  const { loadingFocusIds, inputFocusToken, cancelSuggestions } = suggestions
  const liveTurn = useChatLiveTurn({
    messages,
    sending,
    activeSessionId,
    turnControllers,
    liveTargets,
    chatRepos,
    streamClient: () => app.chatStreamClient,
    titleService: () => app.chatTitleService,
    buildUserContext: (focus) => trackUserState.buildUserContext(focus),
    sessionTitle: (sessionId) => sessionList.sessionTitleFor(sessionId) ?? undefined,
    moveSessionToTop: sessionList.moveSessionToTop,
    ensureActiveSession: sessionList.ensureActiveSession,
    isComposeBlocked,
    lang: () => chatLanguage.value || appLanguage.value,
    translateCitations: () => chatTranslateCitations.value,
    addPending,
    readPending,
    removePending,
    resumeOnePendingTurn: (entry) => resumeOnePendingTurn(entry),
    reflectTurnEvent: (event, sessionId, target) => reflectTurnEvent(event, sessionId, target),
    applyTurnEvent: (event, target) => applyTurnEvent(event, target),
    retryReplacing: () => retry.peekReplacing(),
    toastError: (message) => void toast.error(message),
    t,
  })
  const retry = useChatRetry({
    messages,
    sending,
    isComposeBlocked,
    chatMessages: () => chatRepos().messages,
    sendMessage: (text) => liveTurn.sendMessage(text),
  })

  const actions = useChatActions({
    messages,
    chatMessages: () => chatRepos().messages,
    proactiveState: () => app.repositories().proactiveState,
    notifications: app.notifications,
    addToQueue: (trackId) => playlist.add(trackId),
    t,
  })

  const fold = createChatTurnFold({
    messages,
    sessions,
    activeSessionId,
    usage,
    composeLock,
    takeRetryReplacing: () => retry.takeReplacing(),
    recordInlineHintCooldown: actions.recordInlineHintCooldown,
  })
  const { reflectTurnEvent, applyTurnEvent } = fold

  const feedbackDeps = {
    messages,
    chatMessages: () => chatRepos().messages,
    feedbackService: () => app.chatFeedbackService,
  }

  const cleanup = useChatCleanup({
    sessions,
    activeSessionId,
    messages,
    chatRepos,
    unitOfWork: () => app.repositories().unitOfWork,
    readState,
    readPending,
    clearPendingRecords: pendingTurns.clear,
    cancelAllStreams,
    cancelSuggestions,
  })

  // App.vue owns the native lifecycle wiring (cold start, appStateChange) and
  // calls `resumePendingTurns`, so the store stays free of Capacitor.
  const { resumeOnePendingTurn, resumePendingTurns } = useChatResume({
    messages,
    activeSessionId,
    chatRepos,
    resumeService,
    turnControllers,
    reflectTurnEvent,
    readPending,
    removePending,
    lang: () => chatLanguage.value || appLanguage.value,
  })

  return {
    sessions,
    activeSession: sessionList.activeSession,
    activeSessionId,
    messages,
    sending,
    resumePendingTurns,
    listPendingTurns: readPending,
    clearPendingTurns: cleanup.clearPendingTurns,
    sessionTitleFor: sessionList.sessionTitleFor,
    markAnswerUnread: readState.markAnswerUnread,
    getLastSeenMessageId: readState.getLastSeenMessageId,
    markSessionSeen: readState.markSessionSeen,
    loadingFocusIds,
    inputFocusToken,
    composeBlockedUntil,
    isComposeBlocked,
    resetComposeLock: composeLock.resetComposeLock,
    chatUsage: usage.snapshot,
    unseenProactiveSessionIds,
    refreshSessions: sessionList.refreshSessions,
    openSession: sessionList.openSession,
    openOrCreateFocusedSession: sessionList.openOrCreateFocusedSession,
    appendFocusMessage: sessionList.appendFocusMessage,
    requestSuggestions: suggestions.requestSuggestions,
    requestInputFocus: suggestions.requestInputFocus,
    startNewSession: sessionList.startNewSession,
    ensureActiveSession: sessionList.ensureActiveSession,
    sendMessage: liveTurn.sendMessage,
    cancelStream,
    retryLast: retry.retryLast,
    executeAction: actions.executeAction,
    deleteSession: cleanup.deleteSession,
    clearAll: cleanup.clearAll,
    searchSessions: sessionList.searchSessions,
    submitFeedback: (messageId: ChatMessageId, feedback: ChatFeedbackInput) =>
      submitFeedback(messageId, feedback, feedbackDeps),
  }
})

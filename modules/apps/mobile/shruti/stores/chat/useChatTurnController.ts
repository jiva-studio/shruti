import type { Ref } from "vue"
import type { ChatMessageId, TrackId } from "@lib/domain/core.js"
import type { IChatFeedbackService, IChatResumeService } from "@lib/contracts"
import type { INotificationScheduler } from "@ports/app/index.js"
import type { FocusFragmentPayload } from "@shruti/composables/useTrackUserState.js"
import type { PendingTurn } from "@shruti/stores/chatPendingTurns.js"
import type { AddLibraryItem } from "@shruti/wiring/addLibraryItem.js"
import type { ChatUseCases } from "@shruti/wiring/chatUseCases.js"
import type { ChatMessage, ChatSession } from "@usecases/chat/chatThread.js"
import type { ChatComposePolicy } from "./useChatComposePolicy.js"
import type { ChatStreams } from "./useChatStreams.js"
import type { ChatThreads } from "./useChatThreads.js"
import { useChatActions, type ChatActions } from "./useChatActions.js"
import { submitFeedback, type ChatFeedbackInput } from "./useChatFeedback.js"
import { useChatLiveTurn, type ChatLiveTurnDeps } from "./useChatLiveTurn.js"
import { useChatResume, type ChatResume } from "./useChatResume.js"
import { useChatRetry, type ChatRetry } from "./useChatRetry.js"
import {
  useChatSuggestions,
  type ChatQuestionsService,
  type ChatSuggestions,
} from "./useChatSuggestions.js"
import { createChatTurnFold } from "./useChatTurnFold.js"

export interface ChatTurnController {
  readonly suggestions: ChatSuggestions
  readonly retry: ChatRetry
  readonly actions: ChatActions
  readonly resume: ChatResume
  sendMessage(text: string, options?: { focus?: FocusFragmentPayload }): Promise<void>
  submitFeedback(messageId: ChatMessageId, feedback: ChatFeedbackInput): Promise<void>
}

export interface ChatTurnControllerDeps {
  messages: Ref<ChatMessage[]>
  sending: Ref<boolean>
  sessions: Ref<ChatSession[]>
  activeSessionId: Ref<string | null>
  chat: ChatUseCases
  streams: ChatStreams
  compose: ChatComposePolicy
  threads: ChatThreads
  readPending: () => Promise<PendingTurn[]>
  addPending: (assistantMessageId: string, sessionId: string) => Promise<void>
  removePending: (assistantMessageId: string) => Promise<void>
  services: {
    stream: ChatLiveTurnDeps["streamClient"]
    title: ChatLiveTurnDeps["titleService"]
    questions: () => ChatQuestionsService
    feedback: () => IChatFeedbackService
    resume: () => IChatResumeService
  }
  notifications: INotificationScheduler
  buildUserContext: ChatLiveTurnDeps["buildUserContext"]
  addToQueue: (trackId: TrackId) => Promise<{ ok: boolean; error?: string }>
  addToLibrary: AddLibraryItem
  lang: () => string
  translateCitations: () => boolean
  toastError: (message: string) => void
  t: (key: string) => string
}

/**
 * One turn from question to answer: sending it, folding its events into the
 * thread, retrying it, resuming it after an interruption, and what the answer
 * offers — suggestions, action cards, feedback.
 */
export function useChatTurnController(deps: ChatTurnControllerDeps): ChatTurnController {
  const { messages, sending, sessions, activeSessionId, chat, streams, compose, threads } = deps

  const suggestions = useChatSuggestions({
    messages,
    activeSessionId,
    chatMessages: () => chat.threads().messages,
    questionsService: deps.services.questions,
    lang: deps.lang,
  })
  const liveTurn = useChatLiveTurn({
    messages,
    sending,
    activeSessionId,
    turnControllers: streams.turnControllers,
    liveTargets: streams.liveTargets,
    chatRepos: chat.threads,
    streamClient: deps.services.stream,
    titleService: deps.services.title,
    buildUserContext: deps.buildUserContext,
    sessionTitle: (sessionId) => threads.list.sessionTitleFor(sessionId) ?? undefined,
    moveSessionToTop: threads.list.moveSessionToTop,
    ensureActiveSession: threads.list.ensureActiveSession,
    isComposeBlocked: compose.composeLock.isComposeBlocked,
    lang: deps.lang,
    translateCitations: deps.translateCitations,
    addPending: deps.addPending,
    readPending: deps.readPending,
    removePending: deps.removePending,
    resumeOnePendingTurn: (entry) => resume.resumeOnePendingTurn(entry),
    reflectTurnEvent: (event, sessionId, target) => fold.reflectTurnEvent(event, sessionId, target),
    applyTurnEvent: (event, target) => fold.applyTurnEvent(event, target),
    retryReplacing: () => retry.peekReplacing(),
    toastError: deps.toastError,
    t: deps.t,
  })
  const retry = useChatRetry({
    messages,
    sending,
    isComposeBlocked: compose.composeLock.isComposeBlocked,
    chatMessages: () => chat.threads().messages,
    sendMessage: (text) => liveTurn.sendMessage(text),
  })
  const actions = useChatActions({
    messages,
    chatMessages: () => chat.threads().messages,
    proactiveState: chat.proactiveState,
    notifications: deps.notifications,
    addToQueue: deps.addToQueue,
    addToLibrary: deps.addToLibrary,
    t: deps.t,
  })
  const fold = createChatTurnFold({
    messages,
    sessions,
    activeSessionId,
    usage: compose.usage,
    composeLock: compose.composeLock,
    takeRetryReplacing: () => retry.takeReplacing(),
    recordInlineHintCooldown: actions.recordInlineHintCooldown,
  })
  const feedbackDeps = {
    messages,
    chatMessages: () => chat.threads().messages,
    feedbackService: deps.services.feedback,
  }
  // App.vue owns the native lifecycle wiring (cold start, resume) and calls
  // `resumePendingTurns`, so the store stays free of the platform.
  const resume = useChatResume({
    messages,
    activeSessionId,
    chatRepos: chat.threads,
    resumeService: deps.services.resume,
    turnControllers: streams.turnControllers,
    reflectTurnEvent: fold.reflectTurnEvent,
    readPending: deps.readPending,
    removePending: deps.removePending,
    lang: deps.lang,
  })

  return {
    suggestions,
    retry,
    actions,
    resume,
    sendMessage: liveTurn.sendMessage,
    submitFeedback: (messageId, feedback) => submitFeedback(messageId, feedback, feedbackDeps),
  }
}

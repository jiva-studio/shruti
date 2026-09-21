import type { Ref } from "vue"
import { toastController } from "@ionic/vue"
import type { IChatMessageRepository, IChatSessionRepository } from "@lib/domain/ports/index.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"
import { extractFollowups } from "@lib/chat/chatMarkers.js"
import { runChatTurn, type RunChatTurnEvent } from "@usecases"
import { emitTurnSettled, emitTurnStarted } from "@lectorium/chat/turnNotificationEvents.js"
import { openStorePage } from "@lectorium/utils/openStorePage.js"
import type { FocusFragmentPayload } from "@lectorium/composables/useTrackUserState.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { dropStreamingPlaceholder, randomId, type StreamTarget } from "./chatBubbles.js"
import { toHistoryTurns } from "./chatHistory.js"
import { settleLiveTurn, type LiveTurn, type SettleDeps } from "./liveTurn.js"

export interface ChatLiveTurnDeps extends SettleDeps {
  chatRepos: () => {
    sessions: IChatSessionRepository
    messages: IChatMessageRepository
    now: () => number
  }
  streamClient: () => Parameters<typeof runChatTurn>[1]["stream"]
  titleService: () => Parameters<typeof runChatTurn>[1]["title"]
  buildUserContext: Parameters<typeof runChatTurn>[1]["buildUserContext"]
  /** Session title of the turn's own session, for the server's title pass. */
  sessionTitle: (sessionId: string) => string | undefined
  moveSessionToTop: (sessionId: string, updatedAt: number) => void
  ensureActiveSession: (seedTitle: string) => Promise<string>
  isComposeBlocked: Ref<boolean>
  lang: () => string
  translateCitations: () => boolean
  addPending: (assistantMessageId: string, sessionId: string) => Promise<void>
  reflectTurnEvent: (event: RunChatTurnEvent, sessionId: string, target: StreamTarget) => void
  applyTurnEvent: (event: RunChatTurnEvent, target: StreamTarget) => void
  /** Ids the in-flight Retry is replacing; they stay on screen until the new prompt lands. */
  retryReplacing: () => ReadonlySet<string> | null
  toastError: (message: string) => void
  t: (key: string) => string
}

export interface ChatLiveTurn {
  sendMessage: (text: string, options?: { focus?: FocusFragmentPayload }) => Promise<void>
}

/** Runs one question end to end: the user's bubble, the stream, and the settle. */
export function useChatLiveTurn(deps: ChatLiveTurnDeps): ChatLiveTurn {
  const { messages, sending, activeSessionId, turnControllers, liveTargets } = deps

  async function sendMessage(
    text: string,
    options?: { focus?: FocusFragmentPayload }
  ): Promise<void> {
    const clean = text.trim()
    // The quota lock is enforced here, not only on the composer: suggestion
    // pills and focus-card chips call this directly, and each bypass spends an
    // increment of a counter the server never refunds.
    if (!clean || sending.value || deps.isComposeBlocked.value) return
    sending.value = true

    // Session creation and the user-message persist are local SQLite work, so
    // they run first and the user's bubble appears instantly. Only the
    // assistant reply waits on the network: the auth refresh rides inside
    // `runChatTurn`, right before the stream opens.
    let sessionId: ChatSessionId
    try {
      sessionId = (await deps.ensureActiveSession(clean)) as ChatSessionId
    } catch (err) {
      // `sending` is latched above and the try/finally that releases it starts
      // further down, so a failed session INSERT has to release it here.
      sending.value = false
      console.warn("chat: failed to open a session for this turn", err)
      deps.toastError(deps.t("chat.errUnknown"))
      return
    }
    await runLiveTurn(sessionId, clean, options?.focus)
  }

  async function runLiveTurn(
    sessionId: ChatSessionId,
    text: string,
    focus: FocusFragmentPayload | undefined
  ): Promise<void> {
    const repos = deps.chatRepos()
    // A Retry leaves the failed turn on screen until the replacement bubble
    // lands, so it is still in `messages` — but it must not be sent back as
    // history, nor count towards "is this the session's first assistant turn".
    const replacing = deps.retryReplacing()
    const visible = replacing ? messages.value.filter((m) => !replacing.has(m.id)) : messages.value
    const isFirst = visible.filter((m) => m.role === "assistant" && !m.streaming).length === 0

    const turn: LiveTurn = {
      sessionId,
      target: { messageId: null },
      assistantMsgId: null,
      resumableDrop: false,
      settled: false,
      pendingWrite: Promise.resolve(),
    }

    // Registered immediately before the `try` whose `finally` deregisters it:
    // a controller stranded in `turnControllers` keeps the compose state
    // reporting `sending = true` for the session until relaunch.
    const controller = new AbortController()
    turnControllers.set(sessionId, controller)
    liveTargets.set(sessionId, turn.target)

    try {
      for await (const event of runChatTurn(
        {
          sessionId,
          sessionTitle: deps.sessionTitle(sessionId),
          text,
          lang: deps.lang(),
          translateCitations: deps.translateCitations(),
          history: toHistoryTurns(visible),
          focus,
          isFirstAssistantTurn: isFirst,
          newMessageId: () => randomId() as ChatMessageId,
          signal: controller.signal,
        },
        {
          sessions: repos.sessions,
          messages: repos.messages,
          now: repos.now,
          stream: deps.streamClient(),
          title: deps.titleService(),
          buildUserContext: deps.buildUserContext,
          extractFollowups,
          // Refresh the auth claim inside the turn — after the user bubble is
          // shown, before the stream opens — so a tier flip that happened
          // while backgrounded rides this turn without delaying the message.
          ensureFresh: () => useAuthStore().ensureFresh(),
        }
      )) {
        if (isResumableDrop(event, turn.assistantMsgId)) {
          turn.resumableDrop = true
          continue
        }
        // Caches always, the view only when this turn's session is on screen.
        deps.reflectTurnEvent(event, sessionId, turn.target)
        recordTurnLifecycle(event, turn)
      }
    } catch (err) {
      handleTurnException(err, turn)
    } finally {
      await settleLiveTurn(turn, controller, deps)
    }
  }

  /**
   * Our SSE socket died after the server had accepted the turn — typically the
   * OS froze the WebView when the user left. Not a failure: the server keeps
   * generating and buffers the whole turn, so nothing is surfaced and the
   * resume poll recovers it. Either the drop landed before any prose (an error
   * after the placeholder) or mid-prose (a truncated finalise, whose partial
   * row resume overwrites).
   */
  function isResumableDrop(event: RunChatTurnEvent, assistantMsgId: ChatMessageId | null): boolean {
    if (event.kind === "error") return event.code === "stream" && !!assistantMsgId
    if (event.kind !== "finalised") return false
    const err = event.message.error
    return err?.kind === "truncated" && err.reason === "stream"
  }

  /**
   * App-level turn lifecycle — notification, badge, pending record. It fires
   * regardless of which page is on screen, because the loop lives in the
   * singleton store: the answer must notify even after the user navigates away
   * from the session.
   */
  function recordTurnLifecycle(event: RunChatTurnEvent, turn: LiveTurn): void {
    if (event.kind === "assistant-placeholder") {
      turn.assistantMsgId = event.messageId
      turn.pendingWrite = deps.addPending(event.messageId, turn.sessionId)
      emitTurnStarted({ assistantMessageId: event.messageId, sessionId: turn.sessionId })
    }
    if (event.kind === "finalised") {
      turn.settled = true
      void deps.removePending(event.message.id)
      emitTurnSettled({ assistantMessageId: event.message.id, sessionId: turn.sessionId, ok: true })
    }
    if (event.kind === "error" && turn.assistantMsgId) {
      turn.settled = true
      void deps.removePending(turn.assistantMsgId)
      emitTurnSettled({
        assistantMessageId: turn.assistantMsgId,
        sessionId: turn.sessionId,
        ok: false,
      })
    }
    if (event.kind === "user-message" && activeSessionId.value === turn.sessionId) {
      // Sending implies the session is open and `openSession` cleared seen_at,
      // so only the list order needs touching.
      deps.moveSessionToTop(turn.sessionId, Date.now())
    }
  }

  /**
   * Structural failures (426 protocol mismatch, 503 backend unavailable) drop
   * the placeholder instead of converting it to a failed bubble: they are not
   * retryable at the message level, so a Retry CTA would mislead.
   */
  function handleTurnException(err: unknown, turn: LiveTurn): void {
    if (err instanceof ProtocolVersionMismatchError) {
      void showProtocolMismatchToast()
      dropStreamingPlaceholder(messages, turn.target)
      return
    }
    if (err instanceof BackendUnavailableError) {
      deps.toastError(
        `${deps.t("chat.error.backendUnavailable.title")}: ${deps.t("chat.error.backendUnavailable.body")}`
      )
      dropStreamingPlaceholder(messages, turn.target)
      return
    }
    // `runChatTurn` yields stream-side failures as `error` events, so reaching
    // here means a folded step threw. Surface it inline so the user gets a
    // failed bubble and a Retry rather than a vanishing placeholder — but not
    // in a session they switched to mid-stream.
    const message = err instanceof Error ? err.message : "Stream failed"
    if (activeSessionId.value === turn.sessionId) {
      deps.applyTurnEvent({ kind: "error", code: "stream", message }, turn.target)
    }
  }

  /**
   * Built on `toastController` rather than the wrapped helper, which offers no
   * `buttons` array — the CTA opens the platform store, and the toast is
   * sticky because that action is real.
   */
  async function showProtocolMismatchToast(): Promise<void> {
    const toast = await toastController.create({
      message: `${deps.t("chat.error.protocolMismatch.title")}: ${deps.t("chat.error.protocolMismatch.body")}`,
      duration: 0,
      position: "top",
      color: "danger",
      buttons: [
        { text: deps.t("chat.error.protocolMismatch.cta"), handler: () => openStorePage() },
        { text: "", role: "cancel", icon: "close" },
      ],
    })
    await toast.present()
  }

  return { sendMessage }
}

import type { Ref } from "vue"
import type { ChatStreamEvent, IChatResumeService, ResumedTurn } from "@lib/contracts"
import type { IChatMessageRepository, IChatSessionRepository } from "@lib/domain/ports/index.js"
import type { RunChatTurnEvent } from "@usecases"
import { deliverBufferedTurn, type ReplayDeps } from "./deliverBufferedTurn.js"
import { emitTurnSettled } from "@shruti/chat/turnNotificationEvents.js"
import type { PendingTurn } from "@shruti/stores/chatPendingTurns.js"
import {
  decideResumeRecovery,
  type ResumeDecision,
  type ResumeProbe,
} from "@shruti/stores/chatResumeRecovery.js"
import type { ChatMessage } from "./chatTypes.js"
import { abandonBubble, ensureThinkingPlaceholder, type StreamTarget } from "./chatBubbles.js"

/** Mirrors the server buffer TTL. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000

// Poll cadence: tight while the answer is plausibly seconds away, easing to a
// 15 s ceiling so following a turn to its end costs a poll every 15 s rather
// than one every 2.5 s for the buffer's whole TTL.
const RESUME_POLL_MIN_MS = 2500
const RESUME_POLL_MAX_MS = 15_000

function resumePollDelayMs(attempt: number): number {
  return Math.min(RESUME_POLL_MAX_MS, RESUME_POLL_MIN_MS * 2 ** Math.floor(attempt / 12))
}

export interface ChatResumeRepos {
  sessions: IChatSessionRepository
  messages: IChatMessageRepository
  now: () => number
}

export interface ChatResumeDeps {
  messages: Ref<ChatMessage[]>
  activeSessionId: Ref<string | null>
  chatRepos: () => ChatResumeRepos
  resumeService: () => IChatResumeService
  /** Sessions with a live stream; a controller means a newer turn owns the thread. */
  turnControllers: Map<string, AbortController>
  reflectTurnEvent: (event: RunChatTurnEvent, sessionId: string, target: StreamTarget) => void
  readPending: () => Promise<PendingTurn[]>
  removePending: (assistantMessageId: string) => Promise<void>
  lang: () => string
}

export interface ChatResume {
  resumeOnePendingTurn: (entry: PendingTurn) => Promise<void>
  resumePendingTurns: () => Promise<void>
}

/**
 * Recovers a turn whose live stream dropped: the server keeps generating and
 * buffers the whole answer, so the poll follows it and replays it into the
 * thread where it happened.
 */
export function useChatResume(deps: ChatResumeDeps): ChatResume {
  const { messages, activeSessionId, turnControllers } = deps

  // Dedup guard so overlapping resume triggers don't stack poll loops per turn.
  const resumePolling = new Set<string>()

  const replayDeps: ReplayDeps = {
    chatRepos: deps.chatRepos,
    reflectTurnEvent: deps.reflectTurnEvent,
    removePending: deps.removePending,
    messages,
    lang: deps.lang,
    isOnScreen: (sessionId) => activeSessionId.value === sessionId,
  }

  /**
   * Give up on a turn the poll cannot recover: settle it so the pre-armed
   * notification is cancelled, convert its bubble to the failed/truncated
   * state that carries Retry, and drop the record so nothing re-raises the
   * placeholder.
   */
  async function giveUp(entry: PendingTurn, target?: StreamTarget): Promise<void> {
    emitTurnSettled({
      assistantMessageId: entry.assistantMessageId,
      sessionId: entry.sessionId,
      ok: false,
    })
    if (activeSessionId.value === entry.sessionId) {
      abandonBubble(messages, entry.assistantMessageId, target)
    }
    await deps.removePending(entry.assistantMessageId)
  }

  async function resumeOnePendingTurn(entry: PendingTurn): Promise<void> {
    if (resumePolling.has(entry.assistantMessageId)) return
    resumePolling.add(entry.assistantMessageId)
    // This poll's own bubble — never shared with the live fold, so a turn the
    // user starts mid-poll keeps its own placeholder.
    const target: StreamTarget = { messageId: null }
    const verdict = createVerdict(entry)
    try {
      // Poll until the turn settles or the verdict says it never will — not
      // for a fixed number of rounds: a long research turn whose socket
      // dropped would otherwise spin forever with the answer on the server.
      for (let attempt = 0; ; attempt++) {
        const round = await pollOnce(entry, target, verdict)
        if (round.action === "stop") return
        if (round.action === "retry") {
          await new Promise((resolve) => setTimeout(resolve, resumePollDelayMs(attempt)))
          continue
        }
        await deliverBufferedTurn(
          { entry, events: round.events, target, superseded: round.superseded },
          replayDeps
        )
        return
      }
    } finally {
      resumePolling.delete(entry.assistantMessageId)
    }
  }

  /**
   * The recovery grace window, over the run of non-`running` readings: a
   * `missing` or `unreachable` reading says nothing about whether the answer
   * is still coming, so it is tolerated for a while before the turn is given
   * up on.
   */
  function createVerdict(entry: PendingTurn): (probe: ResumeProbe) => ResumeDecision {
    let unproductiveSince: number | null = null
    return (probe) => {
      if (probe === "running") unproductiveSince = null
      else if (unproductiveSince === null) unproductiveSince = Date.now()
      return decideResumeRecovery({
        probe,
        unproductiveForMs: unproductiveSince === null ? 0 : Date.now() - unproductiveSince,
        ageMs: Date.now() - entry.createdAt,
        ttlMs: PENDING_TTL_MS,
      })
    }
  }

  type Round =
    | { action: "retry" }
    | { action: "stop" }
    | { action: "deliver"; events: readonly ChatStreamEvent[]; superseded: boolean }

  /**
   * One poll round. A controller registered for the session is never this
   * turn — both entry points refuse to start a poll while one exists — so it
   * means a NEWER turn superseded this one: no further round will help, and
   * the record must not survive (it re-arms the notification and re-raises a
   * phantom placeholder for the whole TTL). The round still runs to its
   * `getTurn`, because the server may be holding a finished answer, and a
   * `done`/`error` reading is delivered like any other.
   */
  async function pollOnce(
    entry: PendingTurn,
    target: StreamTarget,
    verdict: (probe: ResumeProbe) => ResumeDecision
  ): Promise<Round> {
    const superseded = turnControllers.has(entry.sessionId)
    let buffered: ResumedTurn | null
    try {
      buffered = await deps.resumeService().getTurn(entry.assistantMessageId)
    } catch {
      // Transient (offline, token refresh, gateway burp): it says nothing
      // about the turn, but it is not recovery either, so it runs the same
      // grace window rather than leaving the placeholder up indefinitely.
      return await unsettledRound(entry, target, superseded, verdict, "unreachable")
    }
    // Never received, expired, or not ours. A 404 in the first seconds after a
    // drop can be the poll racing the server's buffer write, so it is
    // tolerated for the grace window.
    if (buffered === null)
      return await unsettledRound(entry, target, superseded, verdict, "missing")
    if (buffered.state === "running") {
      // A ten-minute research answer is ordinary, so the poll follows it
      // rather than offering a button that would race the recovery. Only the
      // buffer TTL ends it.
      const round = await unsettledRound(entry, target, superseded, verdict, "running")
      // Re-checked here, not only at the top: `getTurn` can take seconds, and
      // a turn the user started inside that window now owns the thread.
      if (
        round.action === "retry" &&
        activeSessionId.value === entry.sessionId &&
        !turnControllers.has(entry.sessionId)
      ) {
        ensureThinkingPlaceholder(messages, entry.sessionId, entry.assistantMessageId, target)
      }
      return round
    }
    return { action: "deliver", events: buffered.events, superseded }
  }

  async function unsettledRound(
    entry: PendingTurn,
    target: StreamTarget,
    superseded: boolean,
    verdict: (probe: ResumeProbe) => ResumeDecision,
    probe: ResumeProbe
  ): Promise<Round> {
    if (superseded || verdict(probe) === "abandon") {
      await giveUp(entry, target)
      return { action: "stop" }
    }
    return { action: "retry" }
  }

  /** On app resume or cold start; turns still streaming live in this session are skipped. */
  async function resumePendingTurns(): Promise<void> {
    for (const entry of await deps.readPending()) {
      if (turnControllers.has(entry.sessionId)) continue
      void resumeOnePendingTurn(entry)
    }
  }

  return { resumeOnePendingTurn, resumePendingTurns }
}

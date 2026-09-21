import type { Ref } from "vue"
import type { IChatResumeService } from "@lib/contracts"
import type { StreamTarget } from "./chatBubbles.js"

export interface ChatStreamsDeps {
  activeSessionId: Ref<string | null>
  sending: Ref<boolean>
  resumeService: () => IChatResumeService
  removePending: (assistantMessageId: string) => Promise<void>
}

export interface ChatStreams {
  /**
   * In-flight turns keyed by sessionId. A turn keeps streaming after the user
   * navigates away from its session — navigation DETACHES rather than aborts,
   * and `runChatTurn` persists the finalised reply either way, so the answer
   * survives a mid-stream session switch.
   */
  turnControllers: Map<string, AbortController>
  /** The live turn's bubble per session, registered alongside its controller. */
  liveTargets: Map<string, StreamTarget>
  cancelStream: () => void
  cancelAllStreams: () => void
  syncComposeBusy: () => void
}

/** Who is streaming right now, and the two ways a stream is stopped. */
export function useChatStreams(deps: ChatStreamsDeps): ChatStreams {
  const { activeSessionId, sending } = deps
  const turnControllers = new Map<string, AbortController>()
  const liveTargets = new Map<string, StreamTarget>()

  /** Explicit Stop: aborts the ACTIVE session's turn; detached turns keep running. */
  function cancelStream(): void {
    const id = activeSessionId.value
    if (!id) return
    const assistantId = liveTargets.get(id)?.messageId ?? null
    const controller = turnControllers.get(id)
    if (controller) {
      controller.abort()
      turnControllers.delete(id)
      liveTargets.delete(id)
    }
    // Stop is not a passive disconnect: cancel the turn server-side and drop
    // it from the resume queue so it is not re-polled or replayed later.
    if (assistantId) {
      void deps.removePending(assistantId)
      void deps.resumeService().cancelTurn(assistantId)
    }
  }

  /** Used before wiping the tables, so no detached turn's finally writes into them. */
  function cancelAllStreams(): void {
    for (const controller of turnControllers.values()) controller.abort()
    turnControllers.clear()
  }

  /**
   * Reflect whether the active session has an in-flight (possibly detached)
   * turn into the compose-busy flag. Called after every session switch, since
   * a turn may still be running in the session just opened.
   */
  function syncComposeBusy(): void {
    const id = activeSessionId.value
    sending.value = id != null && turnControllers.has(id)
  }

  return { turnControllers, liveTargets, cancelStream, cancelAllStreams, syncComposeBusy }
}

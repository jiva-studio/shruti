import type { ChatStreamEvent } from "@lib/contracts"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import { extractFollowups } from "@lib/chat/chatMarkers.js"
import { replayChatTurn, type RunChatTurnEvent } from "@usecases"
import { emitTurnSettled } from "@lectorium/chat/turnNotificationEvents.js"
import type { PendingTurn } from "@lectorium/stores/chatPendingTurns.js"
import type { Ref } from "vue"
import type { ChatMessage } from "./chatTypes.js"
import { resetBubbleForReplay, type StreamTarget } from "./chatBubbles.js"
import type { ChatResumeRepos } from "./useChatResume.js"

export interface ReplayRequest {
  entry: PendingTurn
  events: readonly ChatStreamEvent[]
  target: StreamTarget
  /** A newer turn already owns the thread. */
  superseded: boolean
}

export interface ReplayDeps {
  chatRepos: () => ChatResumeRepos
  reflectTurnEvent: (event: RunChatTurnEvent, sessionId: string, target: StreamTarget) => void
  removePending: (assistantMessageId: string) => Promise<void>
  messages: Ref<ChatMessage[]>
  lang: () => string
  isOnScreen: (sessionId: string) => boolean
}

/**
 * Replay a completed turn's buffered events through `replayChatTurn` — the
 * same fold as the live path. A resumed answer is surfaced like a live one
 * (notification, toast, unread badge) since it arrived while the user was
 * away; an `error` settles too, so the pre-armed forward notification is
 * cancelled instead of firing a false "answer ready".
 */
async function replayBufferedTurn(req: ReplayRequest, deps: ReplayDeps): Promise<void> {
  const { entry, target } = req
  async function* replayEvents(): AsyncIterable<ChatStreamEvent> {
    for (const ev of req.events) yield ev
  }
  const repos = deps.chatRepos()
  for await (const event of replayChatTurn(
    {
      assistantMessageId: entry.assistantMessageId as ChatMessageId,
      sessionId: entry.sessionId as ChatSessionId,
      lang: deps.lang(),
      events: replayEvents(),
      // Keep the recovered answer where its turn happened: `Date.now()` would
      // sort an answer recovered after a newer question below it the next time
      // the session is read off disk.
      finalisedCreatedAt: entry.createdAt,
    },
    { messages: repos.messages, sessions: repos.sessions, extractFollowups, now: repos.now }
  )) {
    deps.reflectTurnEvent(event, entry.sessionId, target)
    if (event.kind === "finalised") {
      emitTurnSettled({
        assistantMessageId: entry.assistantMessageId,
        sessionId: entry.sessionId,
        ok: true,
        // A turn recovered while the user watches the thread run its next
        // question needs no "Sadhu replied" — the answer lands in front of
        // them — but the settle still cancels the pre-armed notification.
        silent: req.superseded && deps.isOnScreen(entry.sessionId),
      })
    } else if (event.kind === "error") {
      emitTurnSettled({
        assistantMessageId: entry.assistantMessageId,
        sessionId: entry.sessionId,
        ok: false,
      })
    }
  }
}

/** A `done` or `error` reading: put the buffered answer into the thread. */
export async function deliverBufferedTurn(req: ReplayRequest, deps: ReplayDeps): Promise<void> {
  const { entry } = req
  // The conversation may have been deleted while the turn was in flight.
  // Replaying would insert the answer into a session that no longer exists
  // and fire a notification whose tap target leads nowhere.
  if ((await deps.chatRepos().sessions.getById(entry.sessionId as ChatSessionId)) === null) {
    emitTurnSettled({
      assistantMessageId: entry.assistantMessageId,
      sessionId: entry.sessionId,
      ok: false,
    })
    await deps.removePending(entry.assistantMessageId)
    return
  }
  try {
    const rows = await deps.chatRepos().messages.listBySession(entry.sessionId as ChatSessionId)
    const existing = rows.find((m) => m.id === entry.assistantMessageId)
    if (existing?.error) {
      // A truncated stub left by the dropped connection: drop it from disk
      // so the full answer replaces it cleanly (the replay would otherwise
      // hit the PK on insert), and blank the bubble in place so the partial
      // prose isn't doubled — in place, because splicing it out would let
      // the replay re-append it under a newer question.
      await deps.chatRepos().messages.delete(entry.assistantMessageId as ChatMessageId)
      resetBubbleForReplay(deps.messages, entry.assistantMessageId)
    }
    if (!existing || existing.error) {
      await replayBufferedTurn(req, deps)
    } else {
      // A clean answer is already on disk (the app was killed after finalise
      // but before the record was cleared), so replaying would duplicate it.
      // It still settles, or a false "answer ready" fires for an answer the
      // user already has.
      emitTurnSettled({
        assistantMessageId: entry.assistantMessageId,
        sessionId: entry.sessionId,
        ok: true,
      })
    }
  } catch (err) {
    console.error("[chat] resume replay failed", err)
  } finally {
    await deps.removePending(entry.assistantMessageId)
  }
}

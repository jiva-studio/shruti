import type { Ref } from "vue"
import type { ChatSessionId } from "@lib/domain/core.js"
import type {
  IChatMessageRepository,
  IChatSessionRepository,
  IUnitOfWork,
} from "@lib/domain/ports/index.js"
import { emitTurnSettled } from "@lectorium/chat/turnNotificationEvents.js"
import type { PendingTurn } from "@lectorium/stores/chatPendingTurns.js"
import type { ChatMessage, ChatSession } from "./chatTypes.js"
import type { ChatReadState } from "./useChatReadState.js"

export interface ChatCleanupDeps {
  sessions: Ref<ChatSession[]>
  activeSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  chatRepos: () => { sessions: IChatSessionRepository; messages: IChatMessageRepository }
  unitOfWork: () => IUnitOfWork
  readState: ChatReadState
  readPending: () => Promise<PendingTurn[]>
  clearPendingRecords: () => Promise<void>
  cancelAllStreams: () => void
  cancelSuggestions: () => void
}

export interface ChatCleanup {
  deleteSession: (id: string) => Promise<void>
  clearAll: () => Promise<void>
  clearPendingTurns: () => Promise<void>
}

/** Removing conversations, and wiping every trace of them this device holds. */
export function useChatCleanup(deps: ChatCleanupDeps): ChatCleanup {
  const { sessions, activeSessionId, messages, readState } = deps

  async function deleteSession(id: string): Promise<void> {
    const repos = deps.chatRepos()
    // One transaction, so a failure cannot delete one half and leave a zombie
    // conversation or orphan messages. Session first: its sync tombstone
    // cascades to the messages server-side, so the journal records one delete
    // for the conversation instead of one per message. The message sweep still
    // runs — the FK cascade is best-effort on the native adapter.
    await deps.unitOfWork().run(async (tx) => {
      // Both writes carry the transaction's handle, so each one's journal
      // entry joins THIS transaction instead of opening a second BEGIN.
      await repos.sessions.delete(id as ChatSessionId, tx)
      await repos.messages.deleteBySession(id as ChatSessionId, tx)
    })
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeSessionId.value === id) {
      activeSessionId.value = null
      messages.value = []
    }
    // Deleting is the other way a conversation stops being unread: without
    // this the dot stays lit with no session left to open. The scroll anchor
    // goes with it.
    readState.forgetUnseen(id)
    await readState.clearAnswerUnread(id)
    await readState.clearLastSeen(id)
  }

  async function clearAll(): Promise<void> {
    // Stop the streams first so a finally-block has as little chance as
    // possible of persisting its reply into the emptied tables. A narrowing,
    // not a guarantee: the abort unwinds `runChatTurn` asynchronously.
    deps.cancelAllStreams()
    deps.cancelSuggestions()
    const repos = deps.chatRepos()
    await repos.messages.clearAll()
    await repos.sessions.clearAll()
    sessions.value = []
    activeSessionId.value = null
    messages.value = []
    // The badge and the scroll anchors are preference-backed, not
    // table-backed: emptying the tables alone leaves the tab dot lit over an
    // empty history.
    await readState.clearAll()
    // `chat:pending_turns` outlives the wipe by up to the server buffer TTL. A
    // turn whose socket dropped before the wipe has no controller to abort, so
    // the next resume would replay it into a deleted session and fire an
    // "answer ready" whose tap target is gone.
    await clearPendingTurns()
  }

  /**
   * Forget every in-flight turn — on sign-out or account switch. The records
   * were minted under the previous identity, and resuming one under the new
   * token 404s, leaving a bubble spinning and re-arming its notification for
   * the whole TTL. Each is settled as failed so its pre-armed notification is
   * cancelled rather than merely orphaned.
   */
  async function clearPendingTurns(): Promise<void> {
    const list = await deps.readPending()
    await deps.clearPendingRecords()
    for (const p of list) {
      emitTurnSettled({
        assistantMessageId: p.assistantMessageId,
        sessionId: p.sessionId,
        ok: false,
      })
    }
  }

  return { deleteSession, clearAll, clearPendingTurns }
}

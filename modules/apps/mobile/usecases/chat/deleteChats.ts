import type { ChatSessionId } from "@lib/domain/core.js"
import type {
  IChatMessageRepository,
  IChatSessionRepository,
  IUnitOfWork,
} from "@lib/domain/ports/index.js"

export interface DeleteChatsDeps {
  readonly sessions: IChatSessionRepository
  readonly messages: IChatMessageRepository
  readonly unitOfWork: IUnitOfWork
}

/**
 * Delete one conversation with its messages, in one transaction, so a failure
 * cannot delete one half and leave a zombie conversation or orphan messages.
 * Session first: its sync tombstone cascades to the messages server-side, so
 * the journal records one delete for the conversation instead of one per
 * message. The message sweep still runs — the FK cascade is best-effort on the
 * native adapter.
 */
export async function deleteChatSession(id: ChatSessionId, deps: DeleteChatsDeps): Promise<void> {
  await deps.unitOfWork.run(async (tx) => {
    // Both writes carry the transaction's handle, so each one's journal entry
    // joins THIS transaction instead of opening a second BEGIN.
    await deps.sessions.delete(id, tx)
    await deps.messages.deleteBySession(id, tx)
  })
}

/**
 * Delete every conversation, in one transaction: a failure leaves both tables
 * as they were, never a conversation without its messages or messages without
 * their conversation.
 */
export async function clearChatHistory(deps: DeleteChatsDeps): Promise<void> {
  await deps.unitOfWork.run(async () => {
    await deps.messages.clearAll()
    await deps.sessions.clearAll()
  })
}

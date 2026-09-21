import type { Ref } from "vue"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/index.js"
import type { ChatMessage } from "./chatTypes.js"
import { findRetryTarget } from "./retryTarget.js"

export interface ChatRetryDeps {
  messages: Ref<ChatMessage[]>
  sending: Ref<boolean>
  isComposeBlocked: Ref<boolean>
  chatMessages: () => IChatMessageRepository
  sendMessage: (text: string) => Promise<void>
}

export interface ChatRetry {
  retryLast: (messageId?: string) => Promise<void>
  /** Ids the in-flight Retry is replacing — read by the live turn's history snapshot. */
  peekReplacing: () => ReadonlySet<string> | null
  /** Same ids, consumed by the fold when the replacement prompt lands. */
  takeReplacing: () => ReadonlySet<string> | null
}

/**
 * Re-asking a failed turn.
 *
 * The old pair is marked rather than spliced out up front, so the thread keeps
 * its last turn on screen until the fresh user bubble is ready and the swap
 * lands in one `messages` write.
 */
export function useChatRetry(deps: ChatRetryDeps): ChatRetry {
  const { messages, sending } = deps

  let replacing: ReadonlySet<string> | null = null

  /**
   * The old pair is deleted from the DB first: hammering Retry on a flaky
   * network would otherwise grow a tail of repeat prompts, and `sendMessage`
   * persists a fresh user row anyway. A `failed` bubble lives in memory only,
   * so its delete is a no-op — the call keeps one path for both variants.
   */
  async function retryLast(messageId?: string): Promise<void> {
    if (sending.value) return
    // Gated on the computed lock, not on the raw deadline: `sendMessage`
    // returns on its first line while the lock is armed, so without this the
    // deletes below would erase the question and its reply — through the sync
    // journal, on every device — and start nothing. The quota-lift re-send
    // clears the deadline before calling in here, so it passes.
    if (deps.isComposeBlocked.value) return
    const target = findRetryTarget(messages.value, messageId)
    if (!target) return

    for (const message of [target.user, target.assistant]) {
      try {
        await deps.chatMessages().delete(message.id as ChatMessageId)
      } catch (err) {
        console.warn("chat: failed to delete a message on retry", err)
      }
    }

    // The `finally` covers a send that bails before the turn starts — the old
    // pair then simply stays on screen.
    replacing = new Set([target.user.id, target.assistant.id])
    try {
      await deps.sendMessage(target.user.content)
    } finally {
      replacing = null
    }
  }

  function peekReplacing(): ReadonlySet<string> | null {
    return replacing
  }

  function takeReplacing(): ReadonlySet<string> | null {
    const ids = replacing
    replacing = null
    return ids
  }

  return { retryLast, peekReplacing, takeReplacing }
}

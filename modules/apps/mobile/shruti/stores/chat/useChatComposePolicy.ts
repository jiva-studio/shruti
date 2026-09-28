import type { Ref } from "vue"
import type { IPreferences } from "@ports/app/index.js"
import type { ChatMessage } from "@usecases/chat/chatThread.js"
import { useChatComposeLock, type ChatComposeLock } from "./useChatComposeLock.js"
import { useChatUsageChip, type ChatUsageChip } from "./useChatUsageChip.js"

export interface ChatComposePolicy {
  readonly usage: ChatUsageChip
  readonly composeLock: ChatComposeLock
}

/** Whether the composer may send: the day's usage the chip shows, and the lock
 *  a rate limit arms. */
export function useChatComposePolicy(deps: {
  preferences: IPreferences
  messages: Ref<ChatMessage[]>
  sending: Ref<boolean>
  /** Re-asks the question the limit swallowed; read lazily because the turn
   *  controller is built after the policy. */
  retryLast: (messageId: string) => Promise<void>
}): ChatComposePolicy {
  const usage = useChatUsageChip(deps.preferences)
  const composeLock = useChatComposeLock({
    usage,
    messages: deps.messages,
    sending: deps.sending,
    retryLast: deps.retryLast,
  })
  return { usage, composeLock }
}

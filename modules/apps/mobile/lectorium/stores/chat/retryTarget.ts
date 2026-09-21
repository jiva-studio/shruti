import type { ChatMessage } from "./chatTypes.js"

export interface RetryTarget {
  /** The failed or truncated assistant bubble. */
  assistant: ChatMessage
  /** The user prompt that produced it, re-sent verbatim. */
  user: ChatMessage
}

/**
 * Locate the turn a Retry replaces: the assistant message carrying an error
 * marker — by id, or the most recent one — together with the prompt above it.
 * Null when either half is missing, which is when there is nothing to re-ask.
 */
export function findRetryTarget(
  messages: readonly ChatMessage[],
  messageId?: string
): RetryTarget | null {
  const assistantIdx = messageId
    ? messages.findIndex((m) => m.id === messageId)
    : lastIndexOf(messages, (m) => m.role === "assistant" && !!m.error)
  if (assistantIdx < 0) return null

  const assistant = messages[assistantIdx]
  if (assistant.role !== "assistant" || !assistant.error) return null

  const userIdx = lastIndexOf(messages.slice(0, assistantIdx), (m) => m.role === "user")
  if (userIdx < 0) return null
  return { assistant, user: messages[userIdx] }
}

function lastIndexOf(messages: readonly ChatMessage[], match: (m: ChatMessage) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (match(messages[i])) return i
  }
  return -1
}

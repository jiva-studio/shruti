/**
 * The id of the last message whose role is `user`.
 *
 * The pin-to-top scroll fires on the streaming-placeholder append, and at that
 * point the user's message sits one slot above the placeholder.
 */
export function findLastUserMessageId(
  messages: readonly { id: string; role: "user" | "assistant" }[]
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === "user") return message.id
  }
  return null
}

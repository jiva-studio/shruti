import { streamChat, type ChatStreamEvent, type ChatTurn } from "@shruti/services/chatClient.js"

/**
 * Composable-style thin wrapper over the typed SSE client. Re-exports
 * the async-iterable `streamChat` so views/stores can `import` from a
 * single chat-feature surface instead of reaching across to
 * `services/`. Kept here per the plan's file layout — the actual
 * stream-orchestration loop lives in `useChatStore.sendMessage`, since
 * it needs reactive access to the message list anyway.
 */
export function useChatStream(): {
  stream: (
    messages: readonly ChatTurn[],
    lang: "ru" | "en",
    signal?: AbortSignal
  ) => AsyncIterable<ChatStreamEvent>
} {
  return {
    stream: (messages, lang, signal) => streamChat(messages, lang, { signal }),
  }
}

export type { ChatStreamEvent, ChatTurn }

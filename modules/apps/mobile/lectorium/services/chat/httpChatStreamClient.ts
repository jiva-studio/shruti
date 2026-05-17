import type {
  ChatStreamEvent as PortChatStreamEvent,
  ChatTurn,
  IChatStreamClient,
  StreamChatOptions,
} from "@ports/app/index.js"
import { streamChat } from "../chatClient.js"

/**
 * Adapts the existing fetch+SSE `streamChat` generator (under
 * `@lectorium/services/chatClient`) to the `IChatStreamClient` port.
 *
 * The port + chatClient already share the wire-protocol type names
 * (delta / tool_start / tool / action / outline / done / error) so
 * this wrapper is a thin pass-through. It exists so the use-case
 * imports a port, not a concrete service — letting tests inject a
 * fake without monkey-patching the chatClient module.
 */
export function createHttpChatStreamClient(): IChatStreamClient {
  return {
    streamChat(
      turns: readonly ChatTurn[],
      lang: "ru" | "en",
      opts?: StreamChatOptions
    ): AsyncIterable<PortChatStreamEvent> {
      // The chatClient generator's event types are structurally compatible
      // with PortChatStreamEvent — same `type` discriminator, same payload
      // shapes. The cast keeps the boundary explicit without runtime cost.
      return streamChat(turns, lang, opts) as AsyncIterable<PortChatStreamEvent>
    },
  }
}

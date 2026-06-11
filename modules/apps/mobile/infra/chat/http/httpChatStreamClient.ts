import type {
  ChatStreamEvent as PortChatStreamEvent,
  ChatTurn,
  IChatStreamClient,
  StreamChatOptions,
} from "@lib/contracts"
import { streamChat, type AccessTokenProvider, type ChatRequest } from "./chatClient.js"

export interface HttpChatStreamClientDeps {
  readonly getAccessToken: AccessTokenProvider
  /** Failover-aware HTTP client for the chat service. The composition
   *  root wires this through `createFailoverClient` so an unreachable
   *  preferred server transparently falls through to others. */
  readonly request: ChatRequest
}

/**
 * Adapts the fetch+SSE `streamChat` generator in `./chatClient.ts` to
 * the `IChatStreamClient` port.
 *
 * The port + chatClient already share the wire-protocol type names
 * (delta / tool_start / tool_end / status / action / done / error)
 * so this wrapper is a thin pass-through. It exists so the use-case
 * imports a port, not a concrete service — letting tests inject a
 * fake without monkey-patching the chatClient module.
 */
export function createHttpChatStreamClient(deps: HttpChatStreamClientDeps): IChatStreamClient {
  return {
    streamChat(
      turns: readonly ChatTurn[],
      lang: string,
      opts?: StreamChatOptions
    ): AsyncIterable<PortChatStreamEvent> {
      // The chatClient generator's event types are structurally compatible
      // with PortChatStreamEvent — same `type` discriminator, same payload
      // shapes. The cast keeps the boundary explicit without runtime cost.
      // We merge the port-shaped opts with the DI'd auth provider before
      // calling into the chatClient (which needs the explicit token).
      return streamChat(turns, lang, {
        ...(opts ?? {}),
        getAccessToken: deps.getAccessToken,
        request: deps.request,
      }) as AsyncIterable<PortChatStreamEvent>
    },
  }
}

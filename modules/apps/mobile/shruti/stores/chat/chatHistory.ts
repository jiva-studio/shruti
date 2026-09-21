import type { ChatTurn } from "@lib/contracts"
import type { ChatMessage } from "./chatTypes.js"

/**
 * The thread as the server should see it: settled messages only, each
 * assistant turn carrying back what it settled.
 *
 * `aliases` is the server-minted integer→chunk map, which lets the agent fold
 * this message's chip markers back into numbered refs; `attributes` carry a
 * setting past the 20 messages the server can see, because the wire layer
 * folds them into one request-level aggregate.
 */
export function toHistoryTurns(visible: readonly ChatMessage[]): ChatTurn[] {
  return visible
    .filter((m) => !m.streaming)
    .map((m) => {
      const turn: ChatTurn = { role: m.role, content: m.content }
      if (m.role !== "assistant") return turn
      if (m.aliases && Object.keys(m.aliases).length > 0) {
        ;(turn as { aliases?: ChatTurn["aliases"] }).aliases = m.aliases
      }
      if (m.attributes) {
        ;(turn as { attributes?: ChatTurn["attributes"] }).attributes = m.attributes
      }
      return turn
    })
}

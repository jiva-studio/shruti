import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"
import type { ChatStreamEvent } from "@lib/contracts"
import type { TurnCards } from "@lib/chat/stream/chatActionFold.js"
import { foldChatEvent, type TurnFoldState } from "@lib/chat/stream/chatStreamFold.js"
import type { RunChatTurnEvent } from "./chatTurnEvents.js"

/** The live and the resume paths feed this same fold. A structural failure
 *  is rethrown; anything else becomes `stream`, which the store retries. */
export async function* foldChatStream(
  source: AsyncIterable<ChatStreamEvent>,
  cards: TurnCards,
  state: TurnFoldState,
  signal: AbortSignal
): AsyncIterable<RunChatTurnEvent> {
  try {
    for await (const event of source) {
      if (signal.aborted) break
      const folded = foldChatEvent(event, cards, state)
      if (folded) yield folded
    }
  } catch (e) {
    if (e instanceof ProtocolVersionMismatchError || e instanceof BackendUnavailableError) throw e
    state.lastError = { code: "stream", message: e instanceof Error ? e.message : "Stream failed" }
  }
}

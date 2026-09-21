import type { ChatAliasEntry, ChatAttributes } from "@lib/domain/chatMessage.js"
import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"
import type { ChatStreamEvent } from "@lib/contracts"
import type { RunChatTurnEvent } from "./chatTurnEvents.js"
import { clearTurnCards, foldAction, foldAliases, type TurnCards } from "./chatActionFold.js"

export interface StreamError {
  code: string
  message: string
  retryAfter?: number
  tier?: string
  resetsAtEpoch?: number
  current?: number
  limit?: number
  keyType?: "user" | "ip"
}

/** What the fold learned, read by the finalise branch once the stream closes. */
export interface TurnFoldState {
  acc: string
  sawDone: boolean
  sawTurnsLimit: boolean
  lastError: StreamError | null
  aliases?: Record<string, ChatAliasEntry>
  /** What the server worked out about the conversation this turn. Unknown
   *  keys ride along without this build understanding them. */
  attributes?: ChatAttributes
}

export function createFoldState(): TurnFoldState {
  return { acc: "", sawDone: false, sawTurnsLimit: false, lastError: null }
}

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
      yield* foldOne(event, cards, state)
    }
  } catch (e) {
    if (e instanceof ProtocolVersionMismatchError || e instanceof BackendUnavailableError) throw e
    state.lastError = { code: "stream", message: e instanceof Error ? e.message : "Stream failed" }
  }
}

async function* foldOne(
  event: ChatStreamEvent,
  cards: TurnCards,
  state: TurnFoldState
): AsyncIterable<RunChatTurnEvent> {
  switch (event.type) {
    case "delta":
      state.acc += event.text
      yield { kind: "delta", text: event.text }
      return
    case "tool_start":
      // A re-run of a tool discards the first pass entirely, prose and cards
      // both, or the finalised message would carry what the first pass emitted.
      state.acc = ""
      clearTurnCards(cards)
      yield { kind: "tool-start" }
      return
    case "action": {
      const folded = foldAction(event.payload)
      if (folded === null) return
      cards[folded.slot][folded.key] = folded.body as never
      yield folded.event
      return
    }
    case "done":
    case "error":
      foldTerminal(event, state)
      return
    default: {
      const forwarded = forwardProgress(event)
      if (forwarded) yield forwarded
    }
  }
}

/** Both are persisted so the next turn can send them back. */
function foldTerminal(
  event: Extract<ChatStreamEvent, { type: "done" | "error" }>,
  state: TurnFoldState
): void {
  if (event.type === "done") {
    if (event.aliases) state.aliases = foldAliases(event.aliases)
    if (event.attributes) state.attributes = event.attributes
    state.sawDone = true
    return
  }
  if (event.code === "max_turns_exceeded") state.sawTurnsLimit = true
  state.lastError = {
    code: event.code,
    message: event.message,
    retryAfter: event.retryAfter,
    tier: event.tier,
    resetsAtEpoch: event.resetsAtEpoch,
    current: event.current,
    limit: event.limit,
    keyType: event.keyType,
  }
}

/** Progress frames the store renders and nothing persists: forwarded as they
 *  arrive, folded into no state. */
function forwardProgress(event: ChatStreamEvent): RunChatTurnEvent | null {
  switch (event.type) {
    case "status":
      return { kind: "status", statusKey: event.key, params: event.params }
    case "research_question":
      return { kind: "research-question", question: event.question }
    case "research_source":
      return {
        kind: "research-source",
        sourceKind: event.sourceKind,
        id: event.id,
        label: event.label,
      }
    case "usage":
      return {
        kind: "usage",
        scope: event.scope,
        current: event.current,
        limit: event.limit,
        resetsAtEpoch: event.resetsAtEpoch,
      }
    default:
      return null
  }
}

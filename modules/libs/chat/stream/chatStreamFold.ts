import type { ChatAliasEntry, ChatAttributes } from "@lib/domain/chatMessage.js"
import type { ChatStreamEvent } from "@lib/contracts"
import type { ChatFoldEvent } from "./chatFoldEvents.js"
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

/** Fold one decoded event into the turn's cards and state. The live and the
 *  resume paths feed the same fold. `null` when the event tells the consumer
 *  nothing: a terminal event, or a card the fold rejected. */
export function foldChatEvent(
  event: ChatStreamEvent,
  cards: TurnCards,
  state: TurnFoldState
): ChatFoldEvent | null {
  switch (event.type) {
    case "delta":
      state.acc += event.text
      return { kind: "delta", text: event.text }
    case "tool_start":
      // A re-run of a tool discards the first pass entirely, prose and cards
      // both, or the finalised message would carry what the first pass emitted.
      state.acc = ""
      clearTurnCards(cards)
      return { kind: "tool-start" }
    case "action": {
      const folded = foldAction(event.payload)
      if (folded === null) return null
      cards[folded.slot][folded.key] = folded.body as never
      return folded.event
    }
    case "done":
    case "error":
      foldTerminal(event, state)
      return null
    default:
      return forwardProgress(event)
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
function forwardProgress(event: ChatStreamEvent): ChatFoldEvent | null {
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

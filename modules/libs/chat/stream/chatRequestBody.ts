import type { ChatAttribute, ChatAttributes, ChatTurn } from "@lib/contracts"
import { attributeValues } from "@lib/domain/chatMessage.js"

/**
 * How many turns the request body may carry — `ChatRequestDto.messages` is
 * `max_length=20` server-side and pydantic rejects a longer list (422) rather
 * than truncating it, so the client must window its local history.
 */
export const CHAT_HISTORY_WINDOW = 20

/** The newest `CHAT_HISTORY_WINDOW` turns, oldest first. */
export function windowChatHistory<T>(turns: readonly T[]): readonly T[] {
  return turns.length > CHAT_HISTORY_WINDOW ? turns.slice(-CHAT_HISTORY_WINDOW) : turns
}

export interface ProactiveTurnOptions {
  readonly ruleKind: "weekly_digest" | "inactivity" | "holiday"
  readonly ruleDate: string // 'YYYY-MM-DD'
  readonly ruleContext: Record<string, unknown>
}

/** The per-turn request fields beside the conversation. Each one is sent only
 *  when the caller sets it; absent means the server default. */
export interface ChatRequestOptions {
  readonly translateCitations?: boolean
  readonly capabilities?: Readonly<Record<string, boolean>>
  readonly sessionId?: string
  readonly sessionTitle?: string
  readonly userContext?: unknown
  readonly proactive?: ProactiveTurnOptions
}

/**
 * Map turns to the server's `ChatMessageDto` shape.
 *
 * Two fields ride BACK on an assistant turn, and both are load-bearing:
 * `aliases` so the agent sees one numbering scheme across the conversation,
 * and `attributes` — what the server settled about the dialogue, e.g. the reply
 * language. The attributes here are the per-message record; what actually
 * carries a setting past the 20 messages the server can see is the aggregate
 * `buildRequestBody` folds out of the full local history.
 */
export function toWireTurns(messages: readonly ChatTurn[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content }
    if (m.role !== "assistant") return out
    if (m.attributes && Object.keys(m.attributes).length > 0) {
      out.attributes = m.attributes
    }
    // snake_case on the wire (track_id / start_ms / end_ms); the domain side is
    // camelCase, so the boundary transforms here.
    if (m.aliases && Object.keys(m.aliases).length > 0) {
      const wireAliases: Record<string, { track_id: string; start_ms?: number; end_ms?: number }> =
        {}
      for (const [k, v] of Object.entries(m.aliases)) {
        const entry: { track_id: string; start_ms?: number; end_ms?: number } = {
          track_id: v.trackId,
        }
        if (typeof v.startMs === "number") entry.start_ms = v.startMs
        if (typeof v.endMs === "number") entry.end_ms = v.endMs
        wireAliases[k] = entry
      }
      out.aliases = wireAliases
    }
    return out
  })
}

export function buildRequestBody(
  messages: readonly ChatTurn[],
  lang: string,
  opts: ChatRequestOptions
): Record<string, unknown> {
  // Newest turns win: the tail is the live exchange, and the current user
  // prompt is always last. Order matters below — the aggregate folds the full
  // history, so the slice must not reach `aggregateAttributes`, otherwise a
  // setting made early in a long conversation would drop off the wire with the
  // messages that carried it.
  return buildRequestEnvelope(
    toWireTurns(windowChatHistory(messages)),
    aggregateAttributes(messages),
    lang,
    opts
  )
}

/**
 * The request around turns already in wire form. `attributes` is turn
 * metadata, not per-message state: what the conversation has settled so far,
 * folded over the client's full local history.
 */
export function buildRequestEnvelope(
  wireTurns: readonly Record<string, unknown>[],
  attributes: ChatAttributes | undefined,
  lang: string,
  opts: ChatRequestOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = { messages: wireTurns, lang }
  if (attributes) body.attributes = attributes
  if (opts.translateCitations) body.translate_citations = true
  if (opts.capabilities && Object.keys(opts.capabilities).length > 0) {
    body.capabilities = opts.capabilities
  }
  if (opts.sessionId !== undefined) body.session_id = opts.sessionId
  if (opts.sessionTitle !== undefined) body.session_title = opts.sessionTitle
  if (opts.userContext !== undefined) body.user_context = opts.userContext
  if (opts.proactive !== undefined) {
    body.proactive = {
      rule_kind: opts.proactive.ruleKind,
      rule_date: opts.proactive.ruleDate,
      rule_context: opts.proactive.ruleContext,
    }
  }
  return body
}

/**
 * Fold every turn's attributes into one map for the request metadata.
 *
 * The server can only see the last 20 messages, so an attribute settled twenty
 * exchanges ago would fall out of its view. The client has the whole
 * conversation, so it folds it here and sends the result once. Later turns win,
 * and something the user stated is not overwritten by a later inference — the
 * same rule the server applies, because both sides fold the same data and must
 * not disagree about it.
 */
export function aggregateAttributes(messages: readonly ChatTurn[]): ChatAttributes | undefined {
  const out: Record<string, ChatAttribute> = {}
  for (const m of messages) {
    if (m.role !== "assistant" || !m.attributes) continue
    for (const [key, attr] of Object.entries(m.attributes)) {
      if (attributeValues(attr).length === 0) continue
      const previous = out[key]
      if (previous && previous.explicit && !attr.explicit) continue
      out[key] = attr
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

import type { ChatAttribute, ChatAttributes, ChatTurn } from "@lib/contracts"
import { attributeValues } from "@lib/domain/chatMessage.js"
import type { StreamChatRequestInit } from "./chatClient.js"

/**
 * How many turns the request body may carry — `ChatRequestDto.messages` is
 * `max_length=20` server-side and pydantic REJECTS a longer list (422), it does
 * not truncate. The client used to ship its whole local history, so a
 * conversation was permanently unsendable from its 21st message on (#1771).
 */
export const CHAT_HISTORY_WINDOW = 20

export function toWireTurns(messages: readonly ChatTurn[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content }
    if (m.role !== "assistant") return out
    // Attributes ride back on the message as provenance; the authoritative
    // copy is the request-level aggregate `buildRequestBody` sends.
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
  opts: StreamChatRequestInit
): Record<string, unknown> {
  // Newest turns win: the tail is the live exchange, and the current user
  // prompt is always last. Order matters below — the aggregate folds the FULL
  // history, so the slice must not reach `aggregateAttributes`, otherwise a
  // setting made early in a long conversation would drop off the wire with the
  // messages that carried it.
  const windowed =
    messages.length > CHAT_HISTORY_WINDOW ? messages.slice(-CHAT_HISTORY_WINDOW) : messages
  const body: Record<string, unknown> = { messages: toWireTurns(windowed), lang }
  // Turn metadata, not per-message state: what the conversation has settled so
  // far, folded over the client's FULL local history.
  const attributes = aggregateAttributes(messages)
  if (attributes) body.attributes = attributes
  // Only emit the flag when the caller opted in — keeps the body identical
  // to the pre-feature shape (and the server default) when it's off.
  if (opts.translateCitations) body.translate_citations = true
  // Client render capabilities — only emit when non-empty so the body stays
  // byte-identical to the pre-feature shape for callers that pass none.
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
 * Fold every turn's attributes into ONE map for the request metadata.
 *
 * The server can only see the last 20 messages, so an attribute settled twenty
 * exchanges ago would fall out of its view. The client has the whole
 * conversation, so it folds it here and sends the result once. Later turns win,
 * and something the user STATED is not overwritten by a later inference — the
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

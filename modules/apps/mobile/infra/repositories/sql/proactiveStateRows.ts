import type { ProactiveRuleId } from "@lib/domain/config.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type {
  ProactivePrepState,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"

export interface ProactiveStateJoinRow {
  readonly chat_message_id: string
  readonly session_id: string
  readonly rule_kind: string
  readonly rule_date: string
  readonly prep_state: string
  readonly prepared_at: number | null
  readonly content: string
  readonly visible_at: number | null
  readonly notify: number
  readonly created_at: number
  readonly seen_at: number | null
}

const PREP_STATES: ReadonlySet<ProactivePrepState> = new Set([
  "pending",
  "ready",
  "degraded",
  "dismissed",
  "superseded",
])

/** Anything below this reads as a year-1973 millisecond stamp, so it is a
 *  seconds value — what `attach()` wrote before #1770. Migration 028 rescales
 *  the stored rows; this keeps a read correct even if it has not run yet. */
const MIN_PLAUSIBLE_EPOCH_MS = 100_000_000_000

function preparedAtMs(raw: number | null): number | null {
  if (raw == null) return null
  const n = Number(raw)
  return n > 0 && n < MIN_PLAUSIBLE_EPOCH_MS ? n * 1000 : n
}

export function rowToEntry(r: ProactiveStateJoinRow): ProactiveStateEntry {
  return {
    chatMessageId: r.chat_message_id as ChatMessageId,
    sessionId: r.session_id as ChatSessionId,
    ruleKind: r.rule_kind as ProactiveRuleId,
    ruleDate: r.rule_date,
    prepState: PREP_STATES.has(r.prep_state as ProactivePrepState)
      ? (r.prep_state as ProactivePrepState)
      : "pending",
    preparedAt: preparedAtMs(r.prepared_at),
    bodyMd: r.content,
    visibleAt: r.visible_at != null ? Number(r.visible_at) : null,
    notify: r.notify === 1,
    createdAt: Number(r.created_at),
    seenAt: r.seen_at != null ? Number(r.seen_at) : null,
  }
}

export const SELECT_JOIN = `
  SELECT p.chat_message_id, m.session_id, p.rule_kind, p.rule_date,
         p.prep_state, p.prepared_at, p.visible_at, p.notify, p.seen_at,
         m.content, m.created_at
    FROM chat_messages_proactive_state p
    JOIN chat_messages m ON m.id = p.chat_message_id
`

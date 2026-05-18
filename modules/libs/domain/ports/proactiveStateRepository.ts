import type { ChatMessageId, ChatSessionId } from "../core.js"
import type { ProactiveRuleId } from "../config.js"

/**
 * Lifecycle states of a proactive (agent-initiated) chat message. The
 * scheduler advances rows through these states between detection,
 * preparation, and visibility.
 *
 * - `pending` — row exists, body_md not yet generated.
 * - `ready` — body_md is fresh and ready to display.
 * - `degraded` — body_md was generated from a fallback path
 *   (backend unreachable, marker validation stripped something). Still
 *   visible, but worth retrying on the next tick.
 * - `dismissed` — user dismissed the action card / closed the
 *   notification without engaging. The cooldown machinery treats this
 *   the same as a successful firing.
 * - `superseded` — the rule's condition lapsed between insertion and
 *   visibility (user already granted permission, already subscribed,
 *   returned from inactivity). Hidden from the chat UI.
 */
export type ProactivePrepState =
  | "pending"
  | "ready"
  | "degraded"
  | "dismissed"
  | "superseded"

/**
 * Snapshot of a proactive message — sidecar state joined with the
 * relevant chat_messages columns so callers don't need to follow up
 * with a second query.
 */
export interface ProactiveStateEntry {
  readonly chatMessageId: ChatMessageId
  readonly sessionId: ChatSessionId
  readonly ruleKind: ProactiveRuleId
  /** `'YYYY-MM-DD'` (local TZ); also used as the dedup key with
   *  `ruleKind`. */
  readonly ruleDate: string
  readonly prepState: ProactivePrepState
  readonly preparedAt: number | null
  /** chat_messages.content — the rendered markdown body. Empty string
   *  while `prepState === 'pending'`. */
  readonly bodyMd: string
  /** chat_messages.visible_on. */
  readonly visibleOn: string | null
  /** chat_messages.notify_at. */
  readonly notifyAt: number | null
  /** chat_messages.notified_at. */
  readonly notifiedAt: number | null
  /** chat_messages.created_at (unix ms). */
  readonly createdAt: number
}

export interface CreateProactiveMessageInput {
  readonly chatMessageId: ChatMessageId
  readonly sessionId: ChatSessionId
  readonly role: "assistant"
  readonly content: string
  readonly createdAt: number
  readonly visibleOn: string | null
  readonly notifyAt: number | null
  readonly ruleKind: ProactiveRuleId
  readonly ruleDate: string
  readonly prepState: ProactivePrepState
}

/**
 * Persistence boundary for the scheduler's bookkeeping. INSERTs happen
 * in pairs (one chat_messages row + one chat_messages_proactive_state
 * row) inside the same transaction; the rest of the API is the small
 * set of state transitions the tick loop performs.
 */
export interface IProactiveStateRepository {
  /**
   * Atomically insert both the visible chat_messages row and its
   * sidecar. Returns `null` if `(ruleKind, ruleDate)` already exists
   * — callers detect dedup that way.
   */
  create(input: CreateProactiveMessageInput): Promise<ProactiveStateEntry | null>

  /** All sidecar rows in the listed prep states, joined with the
   *  visible chat_messages columns. */
  listByPrepStates(
    states: readonly ProactivePrepState[]
  ): Promise<readonly ProactiveStateEntry[]>

  /** Lookup by the dedup key. Used by detectors to skip already-fired
   *  instances. */
  findByRuleAndDate(
    ruleKind: ProactiveRuleId,
    ruleDate: string
  ): Promise<ProactiveStateEntry | null>

  /** Most-recent N entries for a rule. Used by cooldown logic. */
  listRecentByRule(
    ruleKind: ProactiveRuleId,
    limit: number
  ): Promise<readonly ProactiveStateEntry[]>

  /** Transition prep_state. Optionally bump prepared_at in the same
   *  write. */
  updatePrepState(
    chatMessageId: ChatMessageId,
    state: ProactivePrepState,
    preparedAt?: number
  ): Promise<void>

  /** Overwrite the body markdown on the underlying chat_messages row.
   *  Called after a content builder returns. */
  updateContent(chatMessageId: ChatMessageId, content: string): Promise<void>

  /** Stamp `notified_at` so the next tick doesn't re-schedule the same
   *  LocalNotification. */
  markNotified(chatMessageId: ChatMessageId, notifiedAt: number): Promise<void>

  /**
   * Garbage-collect rows in terminal states older than
   * `olderThanUnixSec`. The underlying chat_messages rows are deleted
   * by the FK cascade. Returns the number of rows swept.
   */
  sweepTerminal(olderThanUnixSec: number): Promise<number>
}

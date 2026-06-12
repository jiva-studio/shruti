import type { ChatActionPayload } from "../chatMessage.js"
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
   *  `ruleKind`. Pure idempotency key — NOT a visibility gate. */
  readonly ruleDate: string
  readonly prepState: ProactivePrepState
  readonly preparedAt: number | null
  /** chat_messages.content — the rendered markdown body. Empty string
   *  while `prepState === 'pending'`. */
  readonly bodyMd: string
  /** unix seconds — moment the row becomes visible in chat AND (if
   *  `notify=true`) the moment a LocalNotification fires in the OS.
   *  ONE unified moment. NULL = no visibility gate (real-time only). */
  readonly visibleAt: number | null
  /** Whether to register a LocalNotification at `visibleAt`. */
  readonly notify: boolean
  /** chat_messages.created_at (unix ms). */
  readonly createdAt: number
  /** unix seconds — the moment the user first opened the chat session
   *  containing this proactive message. `null` means it's still
   *  showing as unseen (per-session dot lit, contributes to the tab
   *  badge). */
  readonly seenAt: number | null
}

export interface CreateProactiveMessageInput {
  readonly chatMessageId: ChatMessageId
  readonly sessionId: ChatSessionId
  readonly role: "assistant"
  readonly content: string
  readonly createdAt: number
  /** Unified visible-and-push moment in unix-seconds. NULL allowed only
   *  for `notify=false` (real-time / immediate visibility). When
   *  `notify=true`, `visibleAt` must be non-null. */
  readonly visibleAt: number | null
  readonly notify: boolean
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

  /**
   * Attach a proactive_state row to a chat_message that was created by
   * the regular (non-proactive) chat flow. Used by the inline-hint
   * channel: the LLM emits an `[action:enable_daily_reminder|id=...]`
   * marker during a normal user turn, and we record it as a firing of
   * the matching autonomous rule so the scheduler's cooldown sees it.
   *
   * Returns `null` if `(ruleKind, ruleDate)` already exists OR the
   * `chat_message_id` already has a sidecar row — both are no-ops at
   * this level.
   */
  attach(
    chatMessageId: ChatMessageId,
    ruleKind: ProactiveRuleId,
    ruleDate: string,
    prepState: ProactivePrepState,
    preparedAt?: number
  ): Promise<void>

  /** All sidecar rows in the listed prep states, joined with the
   *  visible chat_messages columns. */
  listByPrepStates(
    states: readonly ProactivePrepState[]
  ): Promise<readonly ProactiveStateEntry[]>

  /** Session ids that have at least one proactive message in `ready` or
   *  `degraded` with `seen_at IS NULL`. Drives both the per-session dot
   *  in the chat list and the tab-level Sadhu badge (badge = count > 0).
   *  Opening the session via `markSeen` clears every row in that session
   *  and drops it out of this set. */
  listUnseenSessionIds(): Promise<readonly ChatSessionId[]>

  /** Stamp `seen_at = atSec` on every proactive row in this session
   *  whose `seen_at` is currently NULL. Called from
   *  `chatStore.openSession` — opening the session is what counts as
   *  "the user saw it". Idempotent. */
  markSeen(sessionId: ChatSessionId, atSec: number): Promise<void>

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

  /** Overwrite the body markdown — and optionally the `actions` map
   *  inside the meta envelope — on the underlying chat_messages row.
   *  Called after a content builder returns. When `actions` is omitted
   *  the existing payload map is left untouched. */
  updateContent(
    chatMessageId: ChatMessageId,
    content: string,
    actions?: Record<string, ChatActionPayload>
  ): Promise<void>

  /**
   * Re-arm a reused proactive row for a fresh cycle: move its
   * visibility moment to `visibleAtSec` and clear `seen_at` so the row
   * goes dormant again (hidden until the new moment) and re-lights the
   * unseen badge when it next becomes due. Used by the inactivity
   * ladder, which keeps ONE stable row and re-anchors it to the user's
   * latest background each time they leave — instead of minting a new
   * row (and chat session) per absence.
   */
  rearm(chatMessageId: ChatMessageId, visibleAtSec: number): Promise<void>

  /**
   * Garbage-collect rows in terminal states older than
   * `olderThanUnixSec`. The underlying chat_messages rows are deleted
   * by the FK cascade. Returns the number of rows swept.
   */
  sweepTerminal(olderThanUnixSec: number): Promise<number>
}

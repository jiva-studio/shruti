import type { IDatabase } from "@ports/app/index.js"
import type { ProactiveRuleId } from "@lib/domain/config.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type {
  CreateProactiveMessageInput,
  IProactiveStateRepository,
  ProactivePrepState,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"

interface ProactiveStateJoinRow {
  readonly chat_message_id: string
  readonly session_id: string
  readonly rule_kind: string
  readonly rule_date: string
  readonly prep_state: string
  readonly prepared_at: number | null
  readonly content: string
  readonly visible_on: string | null
  readonly notify_at: number | null
  readonly notified_at: number | null
  readonly created_at: number
}

const PREP_STATES: ReadonlySet<ProactivePrepState> = new Set([
  "pending",
  "ready",
  "degraded",
  "dismissed",
  "superseded",
])

function rowToEntry(r: ProactiveStateJoinRow): ProactiveStateEntry {
  return {
    chatMessageId: r.chat_message_id as ChatMessageId,
    sessionId: r.session_id as ChatSessionId,
    ruleKind: r.rule_kind as ProactiveRuleId,
    ruleDate: r.rule_date,
    prepState: (PREP_STATES.has(r.prep_state as ProactivePrepState)
      ? (r.prep_state as ProactivePrepState)
      : "pending"),
    preparedAt: r.prepared_at != null ? Number(r.prepared_at) : null,
    bodyMd: r.content,
    visibleOn: r.visible_on,
    notifyAt: r.notify_at != null ? Number(r.notify_at) : null,
    notifiedAt: r.notified_at != null ? Number(r.notified_at) : null,
    createdAt: Number(r.created_at),
  }
}

const SELECT_JOIN = `
  SELECT p.chat_message_id, m.session_id, p.rule_kind, p.rule_date,
         p.prep_state, p.prepared_at,
         m.content, m.visible_on, m.notify_at, m.notified_at, m.created_at
    FROM chat_messages_proactive_state p
    JOIN chat_messages m ON m.id = p.chat_message_id
`

export function createSqlProactiveStateRepository(db: IDatabase): IProactiveStateRepository {
  return {
    async create(input: CreateProactiveMessageInput): Promise<ProactiveStateEntry | null> {
      // Detect dedup up front to avoid a thrown UNIQUE violation inside
      // a transaction (sqlite drivers vary on whether that rolls back
      // the in-flight tx). If a row already exists for this (ruleKind,
      // ruleDate), bail with null and let the caller move on.
      const existing = await db.query<{ chat_message_id: string }>(
        "SELECT chat_message_id FROM chat_messages_proactive_state WHERE rule_kind = ? AND rule_date = ?",
        [input.ruleKind, input.ruleDate]
      )
      if (existing.length > 0) return null

      await db.transaction(async () => {
        // chat_messages insert mirrors the regular chat_messages writer
        // (empty action/outline blobs, no error). Body is whatever the
        // caller passed — usually a fallback template; the real body is
        // written on the next tick via `updateContent`.
        await db.execute(
          `INSERT INTO chat_messages
             (id, session_id, role, content, created_at,
              actions_json, outlines_json, action_states_json, error,
              visible_on, notify_at, notified_at)
           VALUES (?, ?, ?, ?, ?, '{"_v":1,"data":{}}', '{"_v":1,"data":{}}', '{"_v":1,"data":{}}', NULL, ?, ?, NULL)`,
          [
            input.chatMessageId,
            input.sessionId,
            input.role,
            input.content,
            input.createdAt,
            input.visibleOn,
            input.notifyAt,
          ]
        )
        await db.execute(
          `INSERT INTO chat_messages_proactive_state
             (chat_message_id, rule_kind, rule_date, prep_state, prepared_at)
           VALUES (?, ?, ?, ?, NULL)`,
          [input.chatMessageId, input.ruleKind, input.ruleDate, input.prepState]
        )
      })
      await db.save()

      return {
        chatMessageId: input.chatMessageId,
        sessionId: input.sessionId,
        ruleKind: input.ruleKind,
        ruleDate: input.ruleDate,
        prepState: input.prepState,
        preparedAt: null,
        bodyMd: input.content,
        visibleOn: input.visibleOn,
        notifyAt: input.notifyAt,
        notifiedAt: null,
        createdAt: input.createdAt,
      }
    },

    async listByPrepStates(
      states: readonly ProactivePrepState[]
    ): Promise<readonly ProactiveStateEntry[]> {
      if (states.length === 0) return []
      const placeholders = states.map(() => "?").join(",")
      const rows = await db.query<ProactiveStateJoinRow>(
        `${SELECT_JOIN} WHERE p.prep_state IN (${placeholders}) ORDER BY m.created_at ASC`,
        [...states]
      )
      return rows.map(rowToEntry)
    },

    async findByRuleAndDate(
      ruleKind: ProactiveRuleId,
      ruleDate: string
    ): Promise<ProactiveStateEntry | null> {
      const rows = await db.query<ProactiveStateJoinRow>(
        `${SELECT_JOIN} WHERE p.rule_kind = ? AND p.rule_date = ? LIMIT 1`,
        [ruleKind, ruleDate]
      )
      return rows.length > 0 ? rowToEntry(rows[0]) : null
    },

    async listRecentByRule(
      ruleKind: ProactiveRuleId,
      limit: number
    ): Promise<readonly ProactiveStateEntry[]> {
      const rows = await db.query<ProactiveStateJoinRow>(
        `${SELECT_JOIN} WHERE p.rule_kind = ? ORDER BY m.created_at DESC LIMIT ?`,
        [ruleKind, limit]
      )
      return rows.map(rowToEntry)
    },

    async updatePrepState(
      chatMessageId: ChatMessageId,
      state: ProactivePrepState,
      preparedAt?: number
    ): Promise<void> {
      if (preparedAt !== undefined) {
        await db.execute(
          "UPDATE chat_messages_proactive_state SET prep_state = ?, prepared_at = ? WHERE chat_message_id = ?",
          [state, preparedAt, chatMessageId]
        )
      } else {
        await db.execute(
          "UPDATE chat_messages_proactive_state SET prep_state = ? WHERE chat_message_id = ?",
          [state, chatMessageId]
        )
      }
      await db.save()
    },

    async updateContent(
      chatMessageId: ChatMessageId,
      content: string,
      actions?: Record<string, ChatActionPayload>
    ): Promise<void> {
      if (actions !== undefined) {
        // Versioned-record envelope mirrors the format the regular
        // chat_messages writer uses (`{ _v: 1, data: {...} }`), so the
        // existing `parseVersionedRecord` reader picks it up without
        // a separate code path.
        const actionsJson = JSON.stringify({ _v: 1, data: actions })
        await db.execute(
          "UPDATE chat_messages SET content = ?, actions_json = ? WHERE id = ?",
          [content, actionsJson, chatMessageId]
        )
      } else {
        await db.execute("UPDATE chat_messages SET content = ? WHERE id = ?", [
          content,
          chatMessageId,
        ])
      }
      await db.save()
    },

    async markNotified(chatMessageId: ChatMessageId, notifiedAt: number): Promise<void> {
      await db.execute("UPDATE chat_messages SET notified_at = ? WHERE id = ?", [
        notifiedAt,
        chatMessageId,
      ])
      await db.save()
    },

    async sweepTerminal(olderThanUnixSec: number): Promise<number> {
      // chat_messages FK cascade pulls the corresponding proactive_state
      // row out automatically; we drive deletion from chat_messages.
      const olderThanMs = olderThanUnixSec * 1000
      const rows = await db.query<{ chat_message_id: string }>(
        `SELECT p.chat_message_id
           FROM chat_messages_proactive_state p
           JOIN chat_messages m ON m.id = p.chat_message_id
          WHERE p.prep_state IN ('dismissed','superseded')
            AND m.created_at < ?`,
        [olderThanMs]
      )
      if (rows.length === 0) return 0
      const placeholders = rows.map(() => "?").join(",")
      await db.execute(
        `DELETE FROM chat_messages WHERE id IN (${placeholders})`,
        rows.map((r) => r.chat_message_id)
      )
      await db.save()
      return rows.length
    },
  }
}

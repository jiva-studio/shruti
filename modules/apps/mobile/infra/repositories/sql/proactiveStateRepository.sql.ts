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
import { __META_INTERNAL } from "./chatMessagesRepository.sql.js"

const { parseMeta, wrapMeta } = __META_INTERNAL

interface ProactiveStateJoinRow {
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

function rowToEntry(r: ProactiveStateJoinRow): ProactiveStateEntry {
  return {
    chatMessageId: r.chat_message_id as ChatMessageId,
    sessionId: r.session_id as ChatSessionId,
    ruleKind: r.rule_kind as ProactiveRuleId,
    ruleDate: r.rule_date,
    prepState: PREP_STATES.has(r.prep_state as ProactivePrepState)
      ? (r.prep_state as ProactivePrepState)
      : "pending",
    preparedAt: r.prepared_at != null ? Number(r.prepared_at) : null,
    bodyMd: r.content,
    visibleAt: r.visible_at != null ? Number(r.visible_at) : null,
    notify: r.notify === 1,
    createdAt: Number(r.created_at),
    seenAt: r.seen_at != null ? Number(r.seen_at) : null,
  }
}

const SELECT_JOIN = `
  SELECT p.chat_message_id, m.session_id, p.rule_kind, p.rule_date,
         p.prep_state, p.prepared_at, p.visible_at, p.notify, p.seen_at,
         m.content, m.created_at
    FROM chat_messages_proactive_state p
    JOIN chat_messages m ON m.id = p.chat_message_id
`

export function createSqlProactiveStateRepository(db: IDatabase): IProactiveStateRepository {
  return {
    async create(input: CreateProactiveMessageInput): Promise<ProactiveStateEntry | null> {
      if (input.notify && input.visibleAt === null) {
        throw new Error("proactiveState.create: notify=true requires non-null visibleAt")
      }
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
        // (empty meta envelope). Body is whatever the caller passed —
        // usually a fallback template; the real body is written on the
        // next tick via `updateContent`.
        await db.execute(
          `INSERT INTO chat_messages
             (id, session_id, role, content, created_at, meta)
           VALUES (?, ?, ?, ?, ?, '{"_v":1,"data":{}}')`,
          [input.chatMessageId, input.sessionId, input.role, input.content, input.createdAt]
        )
        await db.execute(
          `INSERT INTO chat_messages_proactive_state
             (chat_message_id, rule_kind, rule_date, prep_state, prepared_at,
              visible_at, notify, seen_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`,
          [
            input.chatMessageId,
            input.ruleKind,
            input.ruleDate,
            input.prepState,
            input.visibleAt,
            input.notify ? 1 : 0,
          ]
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
        visibleAt: input.visibleAt,
        notify: input.notify,
        createdAt: input.createdAt,
        seenAt: null,
      }
    },

    async attach(chatMessageId, ruleKind, ruleDate, prepState, preparedAt): Promise<void> {
      // Best-effort attach. Both UNIQUE(rule_kind, rule_date) and the
      // PK on chat_message_id can collide; either way it's a benign
      // no-op for the inline-hint channel — we don't need to bump
      // prep_state on the existing row.
      const dup = await db.query<{ chat_message_id: string }>(
        "SELECT chat_message_id FROM chat_messages_proactive_state WHERE rule_kind = ? AND rule_date = ?",
        [ruleKind, ruleDate]
      )
      if (dup.length > 0) return
      const exists = await db.query<{ chat_message_id: string }>(
        "SELECT chat_message_id FROM chat_messages_proactive_state WHERE chat_message_id = ?",
        [chatMessageId]
      )
      if (exists.length > 0) return
      // Inline-hint markers arrive WHILE the user is reading the agent's
      // reply in the open session — there's nothing to flag as unread.
      // Stamp `seen_at = now` so the per-session dot stays dark and the
      // tab badge doesn't light up. Autonomous proactives go through
      // `create()` above and start with `seen_at = NULL`. Inline-hint
      // rows also have no future-visibility (already visible) and no
      // OS push (the user is already in the conversation).
      await db.execute(
        `INSERT INTO chat_messages_proactive_state
           (chat_message_id, rule_kind, rule_date, prep_state, prepared_at,
            visible_at, notify, seen_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, strftime('%s','now'))`,
        [chatMessageId, ruleKind, ruleDate, prepState, preparedAt ?? null]
      )
      await db.save()
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

    async listUnseenSessionIds(): Promise<readonly ChatSessionId[]> {
      // A session is "unseen" while at least one proactive_state row
      // tied to it has `seen_at IS NULL` AND its prep_state is
      // ready/degraded (pending rows are still being prepped — we
      // don't want the dot to flash before the body is even written).
      // `chatStore.openSession` calls `markSeen` to clear the flag.
      const rows = await db.query<{ session_id: string }>(
        `SELECT DISTINCT m.session_id
           FROM chat_messages_proactive_state p
           JOIN chat_messages m ON m.id = p.chat_message_id
          WHERE p.prep_state IN ('ready', 'degraded')
            AND p.seen_at IS NULL`
      )
      return rows.map((r) => r.session_id as ChatSessionId)
    },

    async markSeen(sessionId: ChatSessionId, atSec: number): Promise<void> {
      // Stamp every NULL-seen row in this session. Subquery on
      // chat_messages.session_id is the bridge — proactive_state
      // doesn't carry session_id directly. Idempotent: rows whose
      // seen_at is already set stay put.
      await db.execute(
        `UPDATE chat_messages_proactive_state
            SET seen_at = ?
          WHERE seen_at IS NULL
            AND chat_message_id IN (
              SELECT id FROM chat_messages WHERE session_id = ?
            )`,
        [atSec, sessionId]
      )
      await db.save()
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
        // Read-modify-write the meta envelope so we keep
        // outlines / actionStates / followups / error untouched.
        const rows = await db.query<{ meta: string | null }>(
          "SELECT meta FROM chat_messages WHERE id = ?",
          [chatMessageId]
        )
        const current = rows.length > 0 ? parseMeta(rows[0].meta) : parseMeta(null)
        const next = wrapMeta({
          actions,
          outlines: current.outlines,
          actionStates: current.actionStates,
          followups: current.followups,
          error: current.error,
          aliases: current.aliases,
          focus: current.focus,
        })
        await db.execute("UPDATE chat_messages SET content = ?, meta = ? WHERE id = ?", [
          content,
          next,
          chatMessageId,
        ])
      } else {
        await db.execute("UPDATE chat_messages SET content = ? WHERE id = ?", [
          content,
          chatMessageId,
        ])
      }
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

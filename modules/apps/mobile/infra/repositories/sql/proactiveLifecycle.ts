import type { IDatabase } from "@ports/app/index.js"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { ChatActionPayload, ChatCiteSnippet } from "@lib/domain/chatMessage.js"
import type {
  IProactiveStateRepository,
  ProactivePrepState,
} from "@lib/domain/ports/proactiveStateRepository.js"
import { mutate } from "@kit/persistence"
import { __META_INTERNAL } from "./chatMessagesRepository.sql.js"
import type { SqlProactiveStateRepositoryDeps } from "./proactiveStateRepository.sql.js"

const { parseMeta, wrapMeta } = __META_INTERNAL

type ProactiveLifecycle = Pick<
  IProactiveStateRepository,
  "updatePrepState" | "updateContent" | "rearm" | "sweepTerminal"
>

/** The state a prepared proactive message moves through after it is created:
 *  prepared, rewritten, re-anchored, and finally swept. */
export function createProactiveLifecycle(
  db: IDatabase,
  deps: SqlProactiveStateRepositoryDeps
): ProactiveLifecycle {
  return {
    async updatePrepState(
      chatMessageId: ChatMessageId,
      state: ProactivePrepState,
      preparedAt?: number
    ): Promise<void> {
      if (preparedAt !== undefined) {
        await mutate(
          db,
          "UPDATE chat_messages_proactive_state SET prep_state = ?, prepared_at = ? WHERE chat_message_id = ?",
          [state, preparedAt, chatMessageId]
        )
      } else {
        await mutate(
          db,
          "UPDATE chat_messages_proactive_state SET prep_state = ? WHERE chat_message_id = ?",
          [state, chatMessageId]
        )
      }
    },

    async updateContent(
      chatMessageId: ChatMessageId,
      content: string,
      actions?: Record<string, ChatActionPayload>,
      cites?: Record<string, ChatCiteSnippet>
    ): Promise<void> {
      if (actions !== undefined || cites !== undefined) {
        // Read-modify-write the meta envelope so we keep the other maps
        // (outlines / actionStates / followups / error …) untouched. Each
        // passed map overrides; an omitted one is preserved.
        const rows = await db.query<{ meta: string | null }>(
          "SELECT meta FROM chat_messages WHERE id = ?",
          [chatMessageId]
        )
        const current = rows.length > 0 ? parseMeta(rows[0].meta) : parseMeta(null)
        // Spread, not a field list: the list silently lost `attributes` when
        // that field was added, and a prepared message forgot its reply
        // language. What is not overridden here is carried over by definition.
        const next = wrapMeta({
          ...current,
          actions: actions ?? current.actions,
          cites: cites ?? current.cites,
        })
        await mutate(db, "UPDATE chat_messages SET content = ?, meta = ? WHERE id = ?", [
          content,
          next,
          chatMessageId,
        ])
      } else {
        await mutate(db, "UPDATE chat_messages SET content = ? WHERE id = ?", [
          content,
          chatMessageId,
        ])
      }
    },

    async rearm(chatMessageId: ChatMessageId, visibleAtSec: number): Promise<void> {
      // Re-anchor a reused row: push visibility to the new moment and
      // clear seen_at so the unseen badge lights again when it surfaces.
      await mutate(
        db,
        "UPDATE chat_messages_proactive_state SET visible_at = ?, seen_at = NULL WHERE chat_message_id = ?",
        [visibleAtSec, chatMessageId]
      )
    },

    async sweepTerminal(olderThanUnixSec: number): Promise<number> {
      const olderThanMs = olderThanUnixSec * 1000
      const rows = await db.query<{ chat_message_id: string; scheduler_authored: number }>(
        `SELECT p.chat_message_id, p.scheduler_authored
           FROM chat_messages_proactive_state p
           JOIN chat_messages m ON m.id = p.chat_message_id
          WHERE p.prep_state IN ('dismissed','superseded')
            AND m.created_at < ?`,
        [olderThanMs]
      )
      if (rows.length === 0) return 0

      // An inline-hint cooldown marker (`scheduler_authored = 0`) is attached
      // to an ordinary assistant answer the user asked for. GC the marker; the
      // host message is not ours to delete (#1770).
      const markers = rows
        .filter((r) => Number(r.scheduler_authored) !== 1)
        .map((r) => r.chat_message_id)
      if (markers.length > 0) {
        const placeholders = markers.map(() => "?").join(",")
        await mutate(
          db,
          `DELETE FROM chat_messages_proactive_state WHERE chat_message_id IN (${placeholders})`,
          markers
        )
      }

      // Scheduler-authored bodies go through the chat-message repository so a
      // message that entered sync gets its tombstone. The FK cascade pulls the
      // sidecar row out with it.
      for (const row of rows.filter((r) => Number(r.scheduler_authored) === 1)) {
        await deps.chatMessages.delete(row.chat_message_id as ChatMessageId)
      }
      return rows.length
    },
  }
}

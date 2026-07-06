import type { IDatabase } from "@ports/app/index.js"
import type { ChatActionState, ChatMessage } from "@lib/domain/chatMessage.js"
import { parseMeta, wrapMeta } from "@lib/domain/chat/messageMeta.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type {
  ChatFeedbackState,
  CreateChatMessageInput,
  IChatMessageRepository,
} from "@lib/domain/ports/chatMessageRepository.js"
import { mutate, queryMany, runInTransaction } from "@kit/persistence"

interface ChatMessageRow {
  readonly id: string
  readonly session_id: string
  readonly role: string
  readonly content: string
  readonly created_at: number
  readonly meta: string | null
}

function rowToMessage(r: ChatMessageRow): ChatMessage {
  const meta = parseMeta(r.meta)
  // CHECK(role IN ('user','assistant')) on the DB side guarantees a
  // valid value here — cast directly without a silent fallback.
  const msg: ChatMessage = {
    id: r.id as ChatMessageId,
    sessionId: r.session_id as ChatSessionId,
    role: r.role as "user" | "assistant",
    content: r.content,
    createdAt: Number(r.created_at),
    actions: meta.actions,
    outlines: meta.outlines,
    media: meta.media,
    verses: meta.verses,
    cites: meta.cites,
    chapters: meta.chapters,
    commentaries: meta.commentaries,
    actionStates: meta.actionStates,
    error: meta.error,
    followups: meta.followups.length > 0 ? meta.followups : undefined,
    aliases: meta.aliases,
    focus: meta.focus,
  }
  if (meta.feedback) {
    msg.feedbackState = meta.feedback.state
    if (meta.feedback.category) msg.feedbackCategory = meta.feedback.category
    if (meta.feedback.comment) msg.feedbackComment = meta.feedback.comment
  }
  return msg
}

export function createSqlChatMessageRepository(db: IDatabase): IChatMessageRepository {
  return {
    async listBySession(sessionId: ChatSessionId): Promise<readonly ChatMessage[]> {
      // Visibility gate now lives on the proactive sidecar
      // (`p.visible_at`). Regular messages have no sidecar row, so the
      // LEFT JOIN's `p.*` come back NULL and the OR-branch admits them.
      // Proactive rows are written in two phases: `create()` inserts the
      // chat_messages row with content="" and prep_state='pending', and
      // the real body lands later via prepIfStale. A persisted pending
      // row (streaming=false, content="") would render a BLANK bubble,
      // so we only surface proactive rows once prep_state is
      // ready/degraded — same gate as `listUnseenSessionIds`. `dismissed`
      // / `superseded` rows stay hidden as before.
      return queryMany<ChatMessageRow, ChatMessage>(
        db,
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.meta
           FROM chat_messages m
           LEFT JOIN chat_messages_proactive_state p ON p.chat_message_id = m.id
          WHERE m.session_id = ?
            AND (p.visible_at IS NULL OR p.visible_at <= unixepoch('now'))
            AND (p.prep_state IS NULL OR p.prep_state IN ('ready','degraded'))
          ORDER BY m.created_at ASC`,
        [sessionId],
        rowToMessage
      )
    },

    async create(input: CreateChatMessageInput): Promise<ChatMessage> {
      const meta = wrapMeta({
        actions: input.actions,
        outlines: input.outlines,
        media: input.media,
        verses: input.verses,
        cites: input.cites,
        chapters: input.chapters,
        commentaries: input.commentaries,
        actionStates: input.actionStates,
        followups: input.followups,
        error: input.error,
        aliases: input.aliases,
        focus: input.focus,
      })
      await mutate(
        db,
        `INSERT INTO chat_messages
           (id, session_id, role, content, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.id, input.sessionId, input.role, input.content, input.createdAt, meta]
      )
      const out: ChatMessage = {
        id: input.id,
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        createdAt: input.createdAt,
        actions: input.actions ?? {},
        outlines: input.outlines ?? {},
        media: input.media ?? {},
        verses: input.verses ?? {},
        cites: input.cites ?? {},
        chapters: input.chapters ?? {},
        commentaries: input.commentaries ?? {},
        actionStates: input.actionStates ?? {},
        error: input.error,
        followups: input.followups && input.followups.length > 0 ? input.followups : undefined,
        aliases: input.aliases && Object.keys(input.aliases).length > 0 ? input.aliases : undefined,
        focus: input.focus,
      }
      return out
    },

    async updateFollowups(id: ChatMessageId, followups: readonly string[]): Promise<void> {
      // Read-modify-write the `meta` envelope, same pattern as
      // `updateActionStates`. Used to persist server-generated
      // Ask-Sadhu chips onto a focus message after `/questions`.
      // Transactional so a concurrent meta update (a streaming turn writing
      // actionStates while this runs) can't clobber the other's field.
      await runInTransaction(db, async () => {
        const rows = await db.query<{ meta: string | null }>(
          "SELECT meta FROM chat_messages WHERE id = ?",
          [id]
        )
        if (rows.length === 0) return
        const current = parseMeta(rows[0].meta)
        const next = wrapMeta({
          actions: current.actions,
          outlines: current.outlines,
          media: current.media,
          verses: current.verses,
          cites: current.cites,
          chapters: current.chapters,
          commentaries: current.commentaries,
          actionStates: current.actionStates,
          followups,
          error: current.error,
          aliases: current.aliases,
          focus: current.focus,
          feedback: current.feedback,
        })
        await mutate(db, "UPDATE chat_messages SET meta = ? WHERE id = ?", [next, id])
      })
    },

    async updateActionStates(
      id: ChatMessageId,
      actionStates: Record<string, ChatActionState>
    ): Promise<void> {
      await runInTransaction(db, async () => {
        const rows = await db.query<{ meta: string | null }>(
          "SELECT meta FROM chat_messages WHERE id = ?",
          [id]
        )
        if (rows.length === 0) return
        const current = parseMeta(rows[0].meta)
        const next = wrapMeta({
          actions: current.actions,
          outlines: current.outlines,
          media: current.media,
          verses: current.verses,
          cites: current.cites,
          chapters: current.chapters,
          commentaries: current.commentaries,
          actionStates,
          followups: current.followups,
          error: current.error,
          aliases: current.aliases,
          focus: current.focus,
          feedback: current.feedback,
        })
        await mutate(db, "UPDATE chat_messages SET meta = ? WHERE id = ?", [next, id])
      })
    },

    async updateFeedback(id: ChatMessageId, feedback: ChatFeedbackState): Promise<void> {
      await runInTransaction(db, async () => {
        const rows = await db.query<{ meta: string | null }>(
          "SELECT meta FROM chat_messages WHERE id = ?",
          [id]
        )
        if (rows.length === 0) return
        const current = parseMeta(rows[0].meta)
        const next = wrapMeta({
          actions: current.actions,
          outlines: current.outlines,
          media: current.media,
          verses: current.verses,
          cites: current.cites,
          chapters: current.chapters,
          commentaries: current.commentaries,
          actionStates: current.actionStates,
          followups: current.followups,
          error: current.error,
          aliases: current.aliases,
          focus: current.focus,
          feedback,
        })
        await mutate(db, "UPDATE chat_messages SET meta = ? WHERE id = ?", [next, id])
      })
    },

    async delete(id: ChatMessageId): Promise<void> {
      await mutate(db, "DELETE FROM chat_messages WHERE id = ?", [id])
    },

    async deleteBySession(sessionId: ChatSessionId): Promise<void> {
      await mutate(db, "DELETE FROM chat_messages WHERE session_id = ?", [sessionId])
    },

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM chat_messages")
    },
  }
}

/** Exported for use by the proactive repository's `updateContent` —
 *  same read-modify-write pattern as `updateActionStates` but for the
 *  `actions` field. Keeps both repos using the same envelope helpers. */
export const __META_INTERNAL = { parseMeta, wrapMeta }

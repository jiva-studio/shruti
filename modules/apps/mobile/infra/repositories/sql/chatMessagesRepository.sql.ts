import type { IDatabase } from "@ports/app/index.js"
import type { ChatActionState, ChatMessage } from "@lib/domain/chatMessage.js"
import { parseMeta, wrapMeta } from "@lib/domain/chat/messageMeta.js"
import type { ParsedMeta } from "@lib/domain/chat/messageMeta.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type {
  ChatFeedbackState,
  CreateChatMessageInput,
  IChatMessageRepository,
} from "@lib/domain/ports/chatMessageRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { mutate, queryMany } from "@kit/persistence"

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
    attributes: meta.attributes,
    focus: meta.focus,
  }
  if (meta.feedback) {
    msg.feedbackState = meta.feedback.state
    if (meta.feedback.category) msg.feedbackCategory = meta.feedback.category
    if (meta.feedback.comment) msg.feedbackComment = meta.feedback.comment
  }
  return msg
}

export function createSqlChatMessageRepository(
  db: IDatabase,
  unitOfWork: IUnitOfWork
): IChatMessageRepository {
  /**
   * Read-modify-write of the `meta` envelope: re-serialises the whole blob
   * with `patch` applied, so a concurrent update (a streaming turn writing
   * actionStates while a `/questions` round-trip writes followups) can't
   * clobber the other's field.
   *
   * Goes through the injected unit of work rather than reaching for
   * `runInTransaction` itself, so the transaction boundary is the composition
   * root's to choose. `createSqlAppRepositories` wires an ISOLATING one
   * (`createSqlUnitOfWork`) — #1531's workaround for the reentrant instance's
   * unbound depth counter, which used to misread this write as nested while
   * any unrelated top-level `run` was in flight and lose it on that
   * transaction's rollback. Since #1493 the join is decided by an explicit
   * transaction handle, which this repository never passes, so either instance
   * is now correct here. See the wiring note in `index.ts`.
   */
  async function rewriteMeta(id: ChatMessageId, patch: Partial<ParsedMeta>): Promise<void> {
    await unitOfWork.run(async () => {
      const rows = await db.query<{ meta: string | null }>(
        "SELECT meta FROM chat_messages WHERE id = ?",
        [id]
      )
      if (rows.length === 0) return
      const next = wrapMeta({ ...parseMeta(rows[0].meta), ...patch })
      await mutate(db, "UPDATE chat_messages SET meta = ? WHERE id = ?", [next, id])
    })
  }

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
      // The prep_state gate applies to scheduler-authored rows ONLY. The other
      // tenant of that table is an inline-hint cooldown marker attached to an
      // ordinary answer (`attach`, `scheduler_authored = 0`): its host was
      // written by the normal chat flow, has a finished body, and must stay in
      // the thread whatever the marker's state says (#1770).
      return queryMany<ChatMessageRow, ChatMessage>(
        db,
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.meta
           FROM chat_messages m
           LEFT JOIN chat_messages_proactive_state p ON p.chat_message_id = m.id
          WHERE m.session_id = ?
            AND (p.visible_at IS NULL OR p.visible_at <= unixepoch('now'))
            AND (p.prep_state IS NULL
                 OR p.scheduler_authored = 0
                 OR p.prep_state IN ('ready','degraded'))
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
        attributes: input.attributes,
        focus: input.focus,
      })
      await mutate(
        db,
        `INSERT INTO chat_messages
           (id, session_id, role, content, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.id, input.sessionId, input.role, input.content, input.createdAt, meta]
      )
      return messageFromInput(input)
    },

    async updateFollowups(id: ChatMessageId, followups: readonly string[]): Promise<void> {
      // Persists the server-generated Ask-Sadhu chips onto a focus message
      // after `/questions`.
      await rewriteMeta(id, { followups })
    },

    async updateActionStates(
      id: ChatMessageId,
      actionStates: Record<string, ChatActionState>
    ): Promise<void> {
      await rewriteMeta(id, { actionStates })
    },

    async updateFeedback(id: ChatMessageId, feedback: ChatFeedbackState): Promise<void> {
      await rewriteMeta(id, { feedback })
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

const orEmpty = <T>(value: Record<string, T> | undefined): Record<string, T> => value ?? {}

/** The row as the caller will see it: every payload map defaults to empty, and
 *  an empty list or alias map reads as absent so the UI need not test both. */
function messageFromInput(input: CreateChatMessageInput): ChatMessage {
  return {
    id: input.id,
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    createdAt: input.createdAt,
    actions: orEmpty(input.actions),
    outlines: orEmpty(input.outlines),
    media: orEmpty(input.media),
    verses: orEmpty(input.verses),
    cites: orEmpty(input.cites),
    chapters: orEmpty(input.chapters),
    commentaries: orEmpty(input.commentaries),
    actionStates: orEmpty(input.actionStates),
    error: input.error,
    followups: nonEmpty(input.followups),
    aliases: nonEmptyMap(input.aliases),
    attributes: input.attributes,
    focus: input.focus,
  }
}

const nonEmpty = <T>(list: readonly T[] | undefined): readonly T[] | undefined =>
  list && list.length > 0 ? list : undefined

const nonEmptyMap = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined =>
  map && Object.keys(map).length > 0 ? map : undefined

/** Exported for use by the proactive repository's `updateContent` —
 *  same read-modify-write pattern as `updateActionStates` but for the
 *  `actions` field. Keeps both repos using the same envelope helpers. */
export const __META_INTERNAL = { parseMeta, wrapMeta }

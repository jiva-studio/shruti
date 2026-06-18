import type { IDatabase } from "@ports/app/index.js"
import type {
  ChatActionPayload,
  ChatActionState,
  ChatAliasEntry,
  ChatChapterBody,
  ChatCiteSnippet,
  ChatCommentaryBody,
  ChatFeedbackCategory,
  ChatFocusPayload,
  ChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
  ChatVerseBody,
  MediaPayload,
} from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId, TrackId } from "@lib/domain/core.js"
import type {
  ChatFeedbackState,
  CreateChatMessageInput,
  IChatMessageRepository,
} from "@lib/domain/ports/chatMessageRepository.js"
import { mutate, queryMany, runInTransaction } from "@kit/persistence"

const FEEDBACK_CATEGORIES: ReadonlySet<ChatFeedbackCategory> = new Set([
  "off_topic",
  "no_results",
  "bad_citations",
  "wrong_language",
  "factually_wrong",
  "other",
])

/** Schema version of the JSON-blob envelope. Bump when payload shapes
 *  evolve non-additively; `parseMeta` handles `_v > known` by rendering
 *  empty (forward-compat with newer apps writing the row). */
const CURRENT_META_V = 1

interface ChatMessageRow {
  readonly id: string
  readonly session_id: string
  readonly role: string
  readonly content: string
  readonly created_at: number
  readonly meta: string | null
}

interface ParsedMeta {
  readonly actions: Record<string, ChatActionPayload>
  readonly outlines: Record<string, ChatOutlinePayload>
  readonly media: Record<string, MediaPayload>
  readonly verses: Record<string, ChatVerseBody>
  readonly cites: Record<string, ChatCiteSnippet>
  readonly chapters: Record<string, ChatChapterBody>
  readonly commentaries: Record<string, ChatCommentaryBody>
  readonly actionStates: Record<string, ChatActionState>
  readonly followups: readonly string[]
  readonly error: ChatMessageError | undefined
  readonly aliases: Record<string, ChatAliasEntry> | undefined
  readonly focus: ChatFocusPayload | undefined
  readonly feedback: ChatFeedbackState | undefined
}

const EMPTY_META: ParsedMeta = Object.freeze({
  actions: {},
  outlines: {},
  media: {},
  verses: {},
  cites: {},
  chapters: {},
  commentaries: {},
  actionStates: {},
  followups: [],
  error: undefined,
  aliases: undefined,
  focus: undefined,
  feedback: undefined,
})

function parseMeta(raw: unknown): ParsedMeta {
  if (typeof raw !== "string" || raw === "") return EMPTY_META
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_META
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_META
  const obj = parsed as Record<string, unknown>
  if (typeof obj._v !== "number" || obj._v > CURRENT_META_V) {
    // Newer schema — bubble renderer falls back to empty rather than
    // crashing on missing fields.
    return EMPTY_META
  }
  const data =
    obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : {}
  return {
    actions: extractRecord<ChatActionPayload>(data.actions),
    outlines: extractRecord<ChatOutlinePayload>(data.outlines),
    media: extractRecord<MediaPayload>(data.media),
    verses: extractRecord<ChatVerseBody>(data.verses),
    cites: extractRecord<ChatCiteSnippet>(data.cites),
    chapters: extractRecord<ChatChapterBody>(data.chapters),
    commentaries: extractRecord<ChatCommentaryBody>(data.commentaries),
    actionStates: extractRecord<ChatActionState>(data.actionStates),
    followups: extractFollowups(data.followups),
    error: parseError(data.error),
    aliases: extractAliases(data.aliases),
    focus: extractFocus(data.focus),
    feedback: extractFeedback(data.feedback),
  }
}

function extractFeedback(raw: unknown): ChatFeedbackState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (o.state !== "up" && o.state !== "down") return undefined
  const out: { state: "up" | "down"; category?: ChatFeedbackCategory; comment?: string } = {
    state: o.state,
  }
  if (
    typeof o.category === "string" &&
    FEEDBACK_CATEGORIES.has(o.category as ChatFeedbackCategory)
  ) {
    out.category = o.category as ChatFeedbackCategory
  }
  if (typeof o.comment === "string" && o.comment.length > 0) out.comment = o.comment
  return out
}

function extractFocus(raw: unknown): ChatFocusPayload | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.trackId !== "string") return undefined
  if (typeof o.startMs !== "number" || typeof o.endMs !== "number") return undefined
  if (typeof o.text !== "string") return undefined
  const out: {
    trackId: TrackId
    startMs: number
    endMs: number
    text: string
    sourceKey?: string
    trackTitle?: string
    authorName?: string
    date?: string
    location?: string
  } = {
    trackId: o.trackId as TrackId,
    startMs: o.startMs,
    endMs: o.endMs,
    text: o.text,
  }
  if (typeof o.sourceKey === "string") out.sourceKey = o.sourceKey
  if (typeof o.trackTitle === "string") out.trackTitle = o.trackTitle
  if (typeof o.authorName === "string") out.authorName = o.authorName
  if (typeof o.date === "string") out.date = o.date
  if (typeof o.location === "string") out.location = o.location
  return out
}

function extractAliases(raw: unknown): Record<string, ChatAliasEntry> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, ChatAliasEntry> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue
    const o = v as Record<string, unknown>
    if (typeof o.trackId !== "string") continue
    const entry: { trackId: string; startMs?: number; endMs?: number } = {
      trackId: o.trackId,
    }
    if (typeof o.startMs === "number") entry.startMs = o.startMs
    if (typeof o.endMs === "number") entry.endMs = o.endMs
    out[k] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function extractRecord<T>(raw: unknown): Record<string, T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return raw as Record<string, T>
}

function extractFollowups(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0)
}

function parseError(raw: unknown): ChatMessageError | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>
  if (obj.kind === "truncated" && (obj.reason === "stream" || obj.reason === "turns")) {
    return { kind: "truncated", reason: obj.reason }
  }
  // User tapped stop mid-stream. Round-trips through SQL so the
  // partial bubble survives cold-start (the user explicitly preserved
  // that prose by stopping rather than letting it continue).
  if (obj.kind === "stopped") {
    return { kind: "stopped" }
  }
  // `failed` is intentionally NOT in the whitelist — failed bubbles
  // are not useful history; they live in memory only and the reload
  // surfaces a clean assistant gap instead.
  // Unknown kind → caller sees `undefined` and renders no error suffix.
  return undefined
}

function wrapMeta(payload: {
  actions?: Record<string, ChatActionPayload>
  outlines?: Record<string, ChatOutlinePayload>
  media?: Record<string, MediaPayload>
  verses?: Record<string, ChatVerseBody>
  cites?: Record<string, ChatCiteSnippet>
  chapters?: Record<string, ChatChapterBody>
  commentaries?: Record<string, ChatCommentaryBody>
  actionStates?: Record<string, ChatActionState>
  followups?: readonly string[]
  error?: ChatMessageError | undefined
  aliases?: Record<string, ChatAliasEntry>
  focus?: ChatFocusPayload
  feedback?: ChatFeedbackState
}): string {
  const data: Record<string, unknown> = {}
  if (payload.actions && Object.keys(payload.actions).length > 0) data.actions = payload.actions
  if (payload.outlines && Object.keys(payload.outlines).length > 0) data.outlines = payload.outlines
  if (payload.media && Object.keys(payload.media).length > 0) data.media = payload.media
  if (payload.verses && Object.keys(payload.verses).length > 0) data.verses = payload.verses
  if (payload.cites && Object.keys(payload.cites).length > 0) data.cites = payload.cites
  if (payload.chapters && Object.keys(payload.chapters).length > 0) data.chapters = payload.chapters
  if (payload.commentaries && Object.keys(payload.commentaries).length > 0)
    data.commentaries = payload.commentaries
  if (payload.actionStates && Object.keys(payload.actionStates).length > 0)
    data.actionStates = payload.actionStates
  if (payload.followups && payload.followups.length > 0) data.followups = payload.followups
  if (payload.error) data.error = payload.error
  if (payload.aliases && Object.keys(payload.aliases).length > 0) data.aliases = payload.aliases
  if (payload.focus) data.focus = payload.focus
  if (payload.feedback) data.feedback = payload.feedback
  return JSON.stringify({ _v: CURRENT_META_V, data })
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

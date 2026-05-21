import type { IDatabase } from "@ports/app/index.js"
import type {
  ChatActionPayload,
  ChatActionState,
  ChatAliasEntry,
  ChatFocusPayload,
  ChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
} from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId, TrackId } from "@lib/domain/core.js"
import type {
  CreateChatMessageInput,
  IChatMessageRepository,
} from "@lib/domain/ports/chatMessageRepository.js"

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
  readonly actionStates: Record<string, ChatActionState>
  readonly followups: readonly string[]
  readonly error: ChatMessageError | undefined
  readonly aliases: Record<string, ChatAliasEntry> | undefined
  readonly focus: ChatFocusPayload | undefined
}

const EMPTY_META: ParsedMeta = Object.freeze({
  actions: {},
  outlines: {},
  actionStates: {},
  followups: [],
  error: undefined,
  aliases: undefined,
  focus: undefined,
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
    actionStates: extractRecord<ChatActionState>(data.actionStates),
    followups: extractFollowups(data.followups),
    error: parseError(data.error),
    aliases: extractAliases(data.aliases),
    focus: extractFocus(data.focus),
  }
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
  // Unknown kind → caller sees `undefined` and renders no error suffix.
  return undefined
}

function wrapMeta(payload: {
  actions?: Record<string, ChatActionPayload>
  outlines?: Record<string, ChatOutlinePayload>
  actionStates?: Record<string, ChatActionState>
  followups?: readonly string[]
  error?: ChatMessageError | undefined
  aliases?: Record<string, ChatAliasEntry>
  focus?: ChatFocusPayload
}): string {
  const data: Record<string, unknown> = {}
  if (payload.actions && Object.keys(payload.actions).length > 0) data.actions = payload.actions
  if (payload.outlines && Object.keys(payload.outlines).length > 0) data.outlines = payload.outlines
  if (payload.actionStates && Object.keys(payload.actionStates).length > 0)
    data.actionStates = payload.actionStates
  if (payload.followups && payload.followups.length > 0) data.followups = payload.followups
  if (payload.error) data.error = payload.error
  if (payload.aliases && Object.keys(payload.aliases).length > 0) data.aliases = payload.aliases
  if (payload.focus) data.focus = payload.focus
  return JSON.stringify({ _v: CURRENT_META_V, data })
}

function rowToMessage(r: ChatMessageRow): ChatMessage {
  const meta = parseMeta(r.meta)
  // CHECK(role IN ('user','assistant')) on the DB side guarantees a
  // valid value here — cast directly without a silent fallback.
  return {
    id: r.id as ChatMessageId,
    sessionId: r.session_id as ChatSessionId,
    role: r.role as "user" | "assistant",
    content: r.content,
    createdAt: Number(r.created_at),
    actions: meta.actions,
    outlines: meta.outlines,
    actionStates: meta.actionStates,
    error: meta.error,
    followups: meta.followups.length > 0 ? meta.followups : undefined,
    aliases: meta.aliases,
    focus: meta.focus,
  }
}

export function createSqlChatMessageRepository(db: IDatabase): IChatMessageRepository {
  return {
    async listBySession(sessionId: ChatSessionId): Promise<readonly ChatMessage[]> {
      // Visibility gate now lives on the proactive sidecar
      // (`p.visible_at`). Regular messages have no sidecar row, so the
      // LEFT JOIN's `p.*` come back NULL and the OR-branch admits them.
      // `dismissed` / `superseded` prep_state rows stay hidden as before.
      const rows = await db.query<ChatMessageRow>(
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.meta
           FROM chat_messages m
           LEFT JOIN chat_messages_proactive_state p ON p.chat_message_id = m.id
          WHERE m.session_id = ?
            AND (p.visible_at IS NULL OR p.visible_at <= unixepoch('now'))
            AND (p.prep_state IS NULL OR p.prep_state NOT IN ('dismissed','superseded'))
          ORDER BY m.created_at ASC`,
        [sessionId]
      )
      return rows.map(rowToMessage)
    },

    async create(input: CreateChatMessageInput): Promise<ChatMessage> {
      const meta = wrapMeta({
        actions: input.actions,
        outlines: input.outlines,
        actionStates: input.actionStates,
        followups: input.followups,
        error: input.error,
        aliases: input.aliases,
        focus: input.focus,
      })
      await db.execute(
        `INSERT INTO chat_messages
           (id, session_id, role, content, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.id, input.sessionId, input.role, input.content, input.createdAt, meta]
      )
      await db.save()
      return {
        id: input.id,
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        createdAt: input.createdAt,
        actions: input.actions ?? {},
        outlines: input.outlines ?? {},
        actionStates: input.actionStates ?? {},
        error: input.error,
        followups: input.followups && input.followups.length > 0 ? input.followups : undefined,
        aliases: input.aliases && Object.keys(input.aliases).length > 0 ? input.aliases : undefined,
        focus: input.focus,
      }
    },

    async updateFollowups(id: ChatMessageId, followups: readonly string[]): Promise<void> {
      // Read-modify-write the `meta` envelope, same pattern as
      // `updateActionStates`. Used to persist server-generated
      // Ask-Sadhu chips onto a focus message after `/questions`.
      const rows = await db.query<{ meta: string | null }>(
        "SELECT meta FROM chat_messages WHERE id = ?",
        [id]
      )
      if (rows.length === 0) return
      const current = parseMeta(rows[0].meta)
      const next = wrapMeta({
        actions: current.actions,
        outlines: current.outlines,
        actionStates: current.actionStates,
        followups,
        error: current.error,
        aliases: current.aliases,
        focus: current.focus,
      })
      await db.execute("UPDATE chat_messages SET meta = ? WHERE id = ?", [next, id])
      await db.save()
    },

    async updateActionStates(
      id: ChatMessageId,
      actionStates: Record<string, ChatActionState>
    ): Promise<void> {
      const rows = await db.query<{ meta: string | null }>(
        "SELECT meta FROM chat_messages WHERE id = ?",
        [id]
      )
      if (rows.length === 0) return
      const current = parseMeta(rows[0].meta)
      const next = wrapMeta({
        actions: current.actions,
        outlines: current.outlines,
        actionStates,
        followups: current.followups,
        error: current.error,
        aliases: current.aliases,
        focus: current.focus,
      })
      await db.execute("UPDATE chat_messages SET meta = ? WHERE id = ?", [next, id])
      await db.save()
    },

    async delete(id: ChatMessageId): Promise<void> {
      await db.execute("DELETE FROM chat_messages WHERE id = ?", [id])
      await db.save()
    },

    async deleteBySession(sessionId: ChatSessionId): Promise<void> {
      await db.execute("DELETE FROM chat_messages WHERE session_id = ?", [sessionId])
      await db.save()
    },

    async clearAll(): Promise<void> {
      await db.execute("DELETE FROM chat_messages")
      await db.save()
    },
  }
}

/** Exported for use by the proactive repository's `updateContent` —
 *  same read-modify-write pattern as `updateActionStates` but for the
 *  `actions` field. Keeps both repos using the same envelope helpers. */
export const __META_INTERNAL = { parseMeta, wrapMeta }

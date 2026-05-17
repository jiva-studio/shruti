import type { IDatabase } from "@ports/app/index.js"
import type {
  ChatActionPayload,
  ChatActionState,
  ChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
} from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type {
  CreateChatMessageInput,
  IChatMessageRepository,
} from "@lib/domain/ports/chatMessageRepository.js"

/** Schema version of the JSON-blob envelope. Bump when payload shapes
 *  evolve non-additively; parseVersionedRecord handles _v > known by
 *  rendering empty (forward-compat with newer apps writing the row). */
const CURRENT_PAYLOAD_V = 1

interface ChatMessageRow {
  readonly id: string
  readonly session_id: string
  readonly role: string
  readonly content: string
  readonly created_at: number
  readonly actions_json: string | null
  readonly outlines_json: string | null
  readonly action_states_json: string | null
  readonly error: string | null
}

function parseVersionedRecord<T>(s: unknown): Record<string, T> {
  if (typeof s !== "string" || s === "") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  if (typeof obj._v === "number") {
    if (obj._v > CURRENT_PAYLOAD_V) {
      // Newer schema — bubble renderer falls back to empty rather than
      // crashing on missing fields.
      return {}
    }
    const data = obj.data
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, T>)
      : {}
  }
  // Legacy (pre-_v) format: parsed object IS the record.
  return obj as Record<string, T>
}

function wrapVersionedRecord<T>(data: Record<string, T>): string {
  return JSON.stringify({ _v: CURRENT_PAYLOAD_V, data })
}

function parseError(raw: unknown): ChatMessageError | undefined {
  if (typeof raw !== "string" || raw === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const obj = parsed as Record<string, unknown>
  if (obj.kind === "truncated" && (obj.reason === "stream" || obj.reason === "turns")) {
    return { kind: "truncated", reason: obj.reason }
  }
  // Unknown kind → caller sees `undefined` and renders no error suffix.
  return undefined
}

function rowToMessage(r: ChatMessageRow): ChatMessage {
  return {
    id: r.id as ChatMessageId,
    sessionId: r.session_id as ChatSessionId,
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    createdAt: Number(r.created_at),
    actions: parseVersionedRecord<ChatActionPayload>(r.actions_json),
    outlines: parseVersionedRecord<ChatOutlinePayload>(r.outlines_json),
    actionStates: parseVersionedRecord<ChatActionState>(r.action_states_json),
    error: parseError(r.error),
  }
}

export function createSqlChatMessageRepository(db: IDatabase): IChatMessageRepository {
  return {
    async listBySession(sessionId: ChatSessionId): Promise<readonly ChatMessage[]> {
      const rows = await db.query<ChatMessageRow>(
        `SELECT id, session_id, role, content, created_at,
                actions_json, outlines_json, action_states_json, error
           FROM chat_messages
          WHERE session_id = ?
          ORDER BY created_at ASC`,
        [sessionId]
      )
      return rows.map(rowToMessage)
    },

    async create(input: CreateChatMessageInput): Promise<ChatMessage> {
      await db.execute(
        `INSERT INTO chat_messages
           (id, session_id, role, content, created_at,
            actions_json, outlines_json, action_states_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.sessionId,
          input.role,
          input.content,
          input.createdAt,
          wrapVersionedRecord(input.actions ?? {}),
          wrapVersionedRecord(input.outlines ?? {}),
          wrapVersionedRecord(input.actionStates ?? {}),
          input.error ? JSON.stringify(input.error) : null,
        ]
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
      }
    },

    async updateActionStates(
      id: ChatMessageId,
      actionStates: Record<string, ChatActionState>
    ): Promise<void> {
      await db.execute("UPDATE chat_messages SET action_states_json = ? WHERE id = ?", [
        wrapVersionedRecord(actionStates),
        id,
      ])
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

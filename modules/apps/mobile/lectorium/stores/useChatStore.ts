import { defineStore } from "pinia"
import { ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { streamChat, type ChatStreamEvent, type ChatTurn } from "@lectorium/services/chatClient.js"

/* -------------------------------------------------------------------------- */
/*                                  Domain                                    */
/* -------------------------------------------------------------------------- */

export interface ChatSession {
  readonly id: string
  readonly title: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ChatMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: "user" | "assistant"
  /** Raw markdown — assistant content can contain [cite:...] / [card:...]. */
  content: string
  readonly createdAt: number
  /** Local-only flag so the UI can show a "thinking…" indicator on the
   *  currently-streaming assistant bubble without leaking that state
   *  into SQLite (we persist final content only). */
  streaming?: boolean
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function deriveTitle(text: string, max = 48): string {
  const trimmed = text.replace(/\s+/g, " ").trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max - 1).trimEnd() + "…"
}

/* -------------------------------------------------------------------------- */
/*                                   Store                                    */
/* -------------------------------------------------------------------------- */

/**
 * Owns the chat tab's reactive state. Single active session at a time;
 * messages are streamed in-place onto the last assistant bubble and
 * persisted to SQLite once the SSE stream finishes (or errors).
 *
 * Lifecycle:
 *   1. `refreshSessions()` — load list for the session sheet
 *   2. `openSession(id)` OR `startNewSession()` — set `activeSessionId`
 *   3. `sendMessage(text)` — append user msg + stream assistant reply
 *   4. `deleteSession(id)` / `clearAll()` — danger-zone operations
 */
export const useChatStore = defineStore("chat", () => {
  const app = useLectorium()
  const appLanguage = useAppLanguage()

  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const sending = ref<boolean>(false)
  const lastError = ref<{ code: string; message: string; retryAfter?: number } | null>(null)

  let abort: AbortController | null = null

  function userDb() {
    const db = app.databases.user
    if (!db) throw new Error("chat-store: user DB is not open yet")
    return db
  }

  async function refreshSessions(): Promise<void> {
    const rows = await userDb().query<{
      id: string
      title: string | null
      created_at: number
      updated_at: number
    }>(
      "SELECT id, title, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT 200"
    )
    sessions.value = rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }))
  }

  async function openSession(id: string): Promise<void> {
    activeSessionId.value = id
    const rows = await userDb().query<{
      id: string
      session_id: string
      role: string
      content: string
      created_at: number
    }>(
      "SELECT id, session_id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
      [id]
    )
    messages.value = rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role === "assistant" ? "assistant" : "user",
      content: r.content,
      createdAt: Number(r.created_at),
    }))
  }

  /**
   * Reset to a blank, unpersisted session. Row is only inserted on the
   * first `sendMessage()` so back-tapping out of an empty chat doesn't
   * leave a debris session in the list.
   */
  function startNewSession(): void {
    if (sending.value) cancelStream()
    activeSessionId.value = null
    messages.value = []
    lastError.value = null
  }

  async function ensureActiveSession(seedTitle: string): Promise<string> {
    if (activeSessionId.value) return activeSessionId.value
    const id = randomId()
    const now = Date.now()
    await userDb().execute(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [id, deriveTitle(seedTitle), now, now]
    )
    activeSessionId.value = id
    sessions.value = [
      { id, title: deriveTitle(seedTitle), createdAt: now, updatedAt: now },
      ...sessions.value,
    ]
    return id
  }

  async function persistMessage(msg: ChatMessage): Promise<void> {
    const db = userDb()
    await db.execute(
      "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      [msg.id, msg.sessionId, msg.role, msg.content, msg.createdAt]
    )
    await db.execute("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", [
      msg.createdAt,
      msg.sessionId,
    ])
    await db.save()
    // Re-order the in-memory session list so the freshly-touched session
    // floats to the top without a roundtrip.
    const idx = sessions.value.findIndex((s) => s.id === msg.sessionId)
    if (idx >= 0) {
      const updated = { ...sessions.value[idx], updatedAt: msg.createdAt }
      sessions.value = [updated, ...sessions.value.filter((_, i) => i !== idx)]
    }
  }

  async function sendMessage(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean || sending.value) return
    lastError.value = null
    sending.value = true

    const sessionId = await ensureActiveSession(clean)
    const userMsg: ChatMessage = {
      id: randomId(),
      sessionId,
      role: "user",
      content: clean,
      createdAt: Date.now(),
    }
    messages.value = [...messages.value, userMsg]
    try {
      await persistMessage(userMsg)
    } catch (err) {
      // Persist failure is non-fatal for the in-memory turn — we'll
      // still attempt to stream a reply, but warn so future history
      // reload shows the gap.
      console.warn("chat: failed to persist user message", err)
    }

    const assistantMsg: ChatMessage = {
      id: randomId(),
      sessionId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      streaming: true,
    }
    messages.value = [...messages.value, assistantMsg]

    abort = new AbortController()
    const lang: "ru" | "en" = appLanguage.value === "ru" ? "ru" : "en"
    const turns: ChatTurn[] = messages.value
      .filter((m) => !m.streaming || m.id !== assistantMsg.id)
      .map((m) => ({ role: m.role, content: m.content }))

    let acc = ""
    try {
      for await (const event of streamChat(turns, lang, { signal: abort.signal })) {
        const finished = applyEvent(
          event,
          assistantMsg,
          (delta) => {
            acc += delta
            updateAssistantContent(assistantMsg.id, acc)
          },
          () => {
            // A tool fired — anything streamed before it was the model's
            // "thinking preamble" ("Я сделаю это с помощью…"). Drop it so
            // only the final post-tool answer survives.
            acc = ""
            updateAssistantContent(assistantMsg.id, acc)
          }
        )
        if (finished) break
      }
    } catch (err) {
      lastError.value = {
        code: "stream",
        message: err instanceof Error ? err.message : "Stream failed",
      }
    } finally {
      abort = null
      sending.value = false
      // Snapshot the bubble: drop the streaming flag and freeze content.
      const idx = messages.value.findIndex((m) => m.id === assistantMsg.id)
      if (idx >= 0) {
        const next = [...messages.value]
        next[idx] = { ...next[idx], content: acc, streaming: false }
        messages.value = next
      }
      if (acc.length > 0) {
        try {
          await persistMessage({ ...assistantMsg, content: acc, streaming: false })
        } catch (err) {
          console.warn("chat: failed to persist assistant message", err)
        }
      } else if (!lastError.value) {
        // No text and no error means an empty done — drop the empty bubble.
        messages.value = messages.value.filter((m) => m.id !== assistantMsg.id)
      } else {
        // Errored before any text — drop the empty bubble; the toast / error
        // banner conveys the failure.
        messages.value = messages.value.filter((m) => m.id !== assistantMsg.id)
      }
    }
  }

  function applyEvent(
    event: ChatStreamEvent,
    assistantMsg: ChatMessage,
    onDelta: (text: string) => void,
    onTool: () => void
  ): boolean {
    switch (event.type) {
      case "delta":
        onDelta(event.text)
        return false
      case "tool":
        onTool()
        return false
      case "done":
        return true
      case "error":
        lastError.value = {
          code: event.code,
          message: event.message,
          retryAfter: event.retryAfter,
        }
        return true
    }
    // exhaustiveness check — keep TS happy if new events are added
    void assistantMsg
    return false
  }

  function updateAssistantContent(messageId: string, content: string): void {
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const next = [...messages.value]
    next[idx] = { ...next[idx], content }
    messages.value = next
  }

  function cancelStream(): void {
    if (abort) {
      abort.abort()
      abort = null
    }
  }

  async function deleteSession(id: string): Promise<void> {
    const db = userDb()
    // chat_messages.ON DELETE CASCADE is declared in the migration, but
    // SQLite only enforces it when `PRAGMA foreign_keys = ON` — which the
    // Capacitor adapter does not toggle by default. Delete manually to be
    // safe across web (sql.js) and native back-ends.
    await db.execute("DELETE FROM chat_messages WHERE session_id = ?", [id])
    await db.execute("DELETE FROM chat_sessions WHERE id = ?", [id])
    await db.save()
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeSessionId.value === id) {
      activeSessionId.value = null
      messages.value = []
    }
  }

  async function clearAll(): Promise<void> {
    // Stop any in-flight SSE stream first — otherwise the streaming
    // finally-block would persist its accumulated reply into the
    // freshly-emptied tables, leaving an orphan row.
    cancelStream()
    const db = userDb()
    await db.execute("DELETE FROM chat_messages")
    await db.execute("DELETE FROM chat_sessions")
    await db.save()
    sessions.value = []
    activeSessionId.value = null
    messages.value = []
  }

  /**
   * Case-insensitive title-only search over the loaded sessions list.
   * Runs in JS because SQLite's `LOWER()` / `LIKE` only fold ASCII and
   * would silently miss Cyrillic uppercase ("Сколько" vs "сколько").
   * Session list is capped at 200 by `refreshSessions`, so a linear
   * scan per keystroke is trivial.
   */
  function searchSessions(query: string): ChatSession[] {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return sessions.value.slice()
    return sessions.value.filter((s) => (s.title ?? "").toLowerCase().includes(needle))
  }

  return {
    sessions,
    activeSessionId,
    messages,
    sending,
    lastError,
    refreshSessions,
    openSession,
    startNewSession,
    sendMessage,
    cancelStream,
    deleteSession,
    clearAll,
    searchSessions,
  }
})

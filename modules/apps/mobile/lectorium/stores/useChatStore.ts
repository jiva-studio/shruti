import { defineStore } from "pinia"
import { ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import {
  useTrackUserState,
  type FocusFragmentPayload,
} from "@lectorium/composables/useTrackUserState.js"
import {
  fetchSessionTitle,
  streamChat,
  type ActionPayload,
  type ChatStreamEvent,
  type ChatTurn,
  type OutlinePayload,
} from "@lectorium/services/chatClient.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"
import { useToast } from "@lectorium/services/useToast.js"
import { useI18n } from "vue-i18n"
import { createNote } from "@lib/application/createNote.js"
import type { TrackId } from "@lib/domain/core.js"

/* -------------------------------------------------------------------------- */
/*                                  Domain                                    */
/* -------------------------------------------------------------------------- */

export interface ChatSession {
  readonly id: string
  readonly title: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export type ActionState = "pending" | "executing" | "done" | "error" | "dismissed"

export interface ChatMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: "user" | "assistant"
  /** Raw markdown — assistant content can contain [cite:...] / [card:...] /
   *  [action:...|id=...] / [outline:track_id] markers. */
  content: string
  readonly createdAt: number
  /** Local-only flag so the UI can show a "thinking…" indicator on the
   *  currently-streaming assistant bubble without leaking that state
   *  into SQLite (we persist final content only). */
  streaming?: boolean
  /** Server-emitted action payloads keyed by `action.id`. The inline
   *  marker `[action:<kind>|id=<id>]` references this map. */
  actions?: Record<string, ActionPayload>
  /** Outline payloads keyed by `track_id`. The inline marker
   *  `[outline:<track_id>]` references this map. */
  outlines?: Record<string, OutlinePayload>
  /** Per-action user-confirmation state. Defaults to "pending" for any
   *  action present in `actions` but not here. */
  actionStates?: Record<string, ActionState>
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
  const trackUserState = useTrackUserState()
  const playlist = usePlaylistStore()
  const notes = useNotesStore()
  const toast = useToast()
  const { t } = useI18n()

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

  /**
   * Versioned payload codec for `actions_json` / `outlines_json` /
   * `action_states_json`. We wrap each record in `{ _v, data }` so we can
   * evolve the payload shape without lockstep migrations:
   *   - reader sees `_v <= CURRENT` → returns `data`
   *   - reader sees `_v > CURRENT`  → returns `{}` (forward-compat: a
   *     newer app wrote this row; rendering an empty card is safer than
   *     crashing on missing fields)
   *   - reader sees no `_v`         → legacy raw record, returned as-is
   *
   * Bump `CURRENT_PAYLOAD_V` whenever the in-record shape changes in a
   * non-additive way, and add a migration arm here that up-converts old
   * versions instead of returning `{}`.
   */
  const CURRENT_PAYLOAD_V = 1

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
        console.warn(
          `[chat] payload schema v${obj._v} > known v${CURRENT_PAYLOAD_V}; rendering empty`
        )
        return {}
      }
      const data = obj.data
      return data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, T>)
        : {}
    }
    // Legacy format (pre-_v): the parsed object IS the record.
    return obj as Record<string, T>
  }

  function wrapVersionedRecord<T>(data: Record<string, T>): string {
    return JSON.stringify({ _v: CURRENT_PAYLOAD_V, data })
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
      actions_json: string | null
      outlines_json: string | null
      action_states_json: string | null
    }>(
      `SELECT id, session_id, role, content, created_at,
              actions_json, outlines_json, action_states_json
         FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at ASC`,
      [id]
    )
    messages.value = rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role === "assistant" ? "assistant" : "user",
      content: r.content,
      createdAt: Number(r.created_at),
      actions: parseVersionedRecord<ActionPayload>(r.actions_json),
      outlines: parseVersionedRecord<OutlinePayload>(r.outlines_json),
      actionStates: parseVersionedRecord<ActionState>(r.action_states_json),
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

  /**
   * Replace the session's auto-derived title (truncated user prompt) with
   * a 3-5 word LLM-generated title. Runs in the background — failures are
   * silent and leave the original title in place.
   */
  async function refreshSessionTitle(
    sessionId: string,
    forMessages: readonly ChatMessage[],
    lang: "ru" | "en"
  ): Promise<void> {
    const turns: ChatTurn[] = forMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }))
    const newTitle = await fetchSessionTitle(turns, lang)
    if (!newTitle) return
    try {
      await userDb().execute(
        "UPDATE chat_sessions SET title = ? WHERE id = ?",
        [newTitle, sessionId]
      )
      await userDb().save()
    } catch (err) {
      console.warn("chat: failed to persist new title", err)
      return
    }
    const idx = sessions.value.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      const next = [...sessions.value]
      next[idx] = { ...next[idx], title: newTitle }
      sessions.value = next
    }
  }

  async function persistMessage(msg: ChatMessage): Promise<void> {
    const db = userDb()
    await db.execute(
      `INSERT INTO chat_messages
         (id, session_id, role, content, created_at,
          actions_json, outlines_json, action_states_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.createdAt,
        wrapVersionedRecord(msg.actions ?? {}),
        wrapVersionedRecord(msg.outlines ?? {}),
        wrapVersionedRecord(msg.actionStates ?? {}),
      ]
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

  async function sendMessage(
    text: string,
    options?: { focus?: FocusFragmentPayload }
  ): Promise<void> {
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
      actions: {},
      outlines: {},
      actionStates: {},
    }
    messages.value = [...messages.value, assistantMsg]

    abort = new AbortController()
    const lang: "ru" | "en" = appLanguage.value === "ru" ? "ru" : "en"
    const turns: ChatTurn[] = messages.value
      .filter((m) => !m.streaming || m.id !== assistantMsg.id)
      .map((m) => ({ role: m.role, content: m.content }))

    // Snapshot user state for personalization tools. Failures degrade
    // gracefully — server tolerates missing `user_context`.
    // `options?.focus` tags this one request with a span the agent
    // should retell (outline chapter tap, citation re-ask, ...).
    let userContext: unknown = undefined
    try {
      userContext = await trackUserState.buildUserContext(options?.focus)
    } catch (err) {
      console.warn("chat: failed to build user_context", err)
    }

    let acc = ""
    try {
      for await (const event of streamChat(turns, lang, {
        signal: abort.signal,
        userContext,
      })) {
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
      const finalised = idx >= 0
        ? { ...messages.value[idx], content: acc, streaming: false }
        : { ...assistantMsg, content: acc, streaming: false }
      if (idx >= 0) {
        const next = [...messages.value]
        next[idx] = finalised
        messages.value = next
      }
      if (acc.length > 0) {
        try {
          await persistMessage(finalised)
        } catch (err) {
          console.warn("chat: failed to persist assistant message", err)
        }
        // Background title refresh — only on the very first round-trip
        // (one user + one assistant turn). Subsequent turns keep the
        // generated title. Fire-and-forget — failures are silent.
        if (
          messages.value.filter((m) => m.role === "assistant" && !m.streaming).length === 1
        ) {
          void refreshSessionTitle(sessionId, [userMsg, finalised], lang)
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
      case "action":
        mergeActionInto(assistantMsg.id, event.payload)
        return false
      case "outline":
        mergeOutlineInto(assistantMsg.id, event.payload)
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
    return false
  }

  function mergeActionInto(messageId: string, payload: ActionPayload): void {
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const prev = messages.value[idx]
    const actions = { ...(prev.actions ?? {}), [payload.id]: payload }
    const actionStates = { ...(prev.actionStates ?? {}) }
    if (!actionStates[payload.id]) actionStates[payload.id] = "pending"
    const next = [...messages.value]
    next[idx] = { ...prev, actions, actionStates }
    messages.value = next
  }

  function mergeOutlineInto(messageId: string, payload: OutlinePayload): void {
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const prev = messages.value[idx]
    const outlines = { ...(prev.outlines ?? {}), [payload.trackId]: payload }
    const next = [...messages.value]
    next[idx] = { ...prev, outlines }
    messages.value = next
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

  async function setActionState(
    messageId: string,
    actionId: string,
    state: ActionState
  ): Promise<void> {
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const prev = messages.value[idx]
    const actionStates = { ...(prev.actionStates ?? {}), [actionId]: state }
    const next = [...messages.value]
    next[idx] = { ...prev, actionStates }
    messages.value = next
    // Persist the new state map only (small write).
    try {
      await userDb().execute(
        "UPDATE chat_messages SET action_states_json = ? WHERE id = ?",
        [wrapVersionedRecord(actionStates), messageId]
      )
      await userDb().save()
    } catch (err) {
      console.warn("chat: failed to persist action state", err)
    }
  }

  /** Execute the action the user just confirmed. Idempotent on `done`. */
  async function executeAction(messageId: string, actionId: string): Promise<void> {
    const msg = messages.value.find((m) => m.id === messageId)
    if (!msg) return
    const action = msg.actions?.[actionId]
    if (!action) return
    const currentState = msg.actionStates?.[actionId] ?? "pending"
    if (currentState === "executing" || currentState === "done") return

    await setActionState(messageId, actionId, "executing")
    try {
      if (action.kind === "create_playlist") {
        // `playlist.add` returns a Result — `not-ok` here means "already in
        // playlist" (or another business rule), NOT a thrown failure. We
        // treat those as success: the trackId IS in the playlist after.
        for (const trackId of action.trackIds) {
          await playlist.add(trackId as TrackId)
        }
        // No toast — the card's own "done" hint is the confirmation.
      } else if (action.kind === "save_note") {
        const result = await createNote(
          {
            trackId: action.trackId as TrackId,
            text: action.text,
            timeStart: Math.max(0, action.startMs),
            timeEnd: Math.max(action.startMs, action.endMs),
          },
          { notes: app.repositories().notes }
        )
        if (!result.ok) throw new Error(`createNote failed: ${result.error}`)
        await notes.refresh()
        await toast.info(t("chat.noteSaved"))
      }
      await setActionState(messageId, actionId, "done")
    } catch (err) {
      console.warn("chat: action execution failed", err)
      await setActionState(messageId, actionId, "error")
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
    executeAction,
    deleteSession,
    clearAll,
    searchSessions,
  }
})

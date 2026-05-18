import { defineStore } from "pinia"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import {
  useTrackUserState,
  type FocusFragmentPayload,
} from "@lectorium/composables/useTrackUserState.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useToast } from "@lectorium/services/useToast.js"
import { applyDailyReminder } from "@lectorium/composables/useDailyReminder.js"
import {
  extractFollowups,
  parseChatMarkers,
} from "@lectorium/views/Chat/composables/useMarkerParser.js"
import {
  addTracksToPlaylist,
  runChatTurn,
  type RunChatTurnEvent,
} from "@lib/application"
import type {
  ChatActionPayload,
  ChatActionState,
  ChatMessage as DomainChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
  ChatSession as DomainChatSession,
  SmartLibraryFiltersPayload,
} from "@lib/domain"
import type { ChatMessageId, ChatSessionId, TrackId } from "@lib/domain/core.js"
import { createHttpChatStreamClient } from "@lectorium/services/chat/httpChatStreamClient.js"
import { createHttpChatTitleService } from "@lectorium/services/chat/httpChatTitleService.js"
import {
  createSqlChatSessionRepository,
  createSqlChatMessageRepository,
} from "@infra/repositories/sql/index.js"
import type { ChatTurn } from "@ports/app/index.js"

/* -------------------------------------------------------------------------- */
/*                                  Domain                                    */
/* -------------------------------------------------------------------------- */

// Re-export domain types so consumers can keep importing them from
// `@lectorium/stores/useChatStore` (the legacy path) while the
// canonical declarations live in `@lib/domain`.
export type ChatSession = DomainChatSession
export type ChatMessage = DomainChatMessage & { streaming?: boolean }
export type ActionPayload = ChatActionPayload
export type OutlinePayload = ChatOutlinePayload
export type ActionState = ChatActionState
export type { ChatMessageError }

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

/**
 * Log a structured warning for every `[action:<kind>|id=X]` marker the
 * LLM emitted whose id has no matching payload in `message.actions`. The
 * card renders the broken-state placeholder anyway; we surface the
 * mismatch so residual marker/payload-id drift is greppable in logs
 * after the agent-side tool-call validation lands.
 *
 * Doesn't throw, doesn't mutate the message — pure observability.
 */
function warnOrphanActionMarkers(message: ChatMessage): void {
  if (message.role !== "assistant") return
  const tokens = parseChatMarkers(message.content)
  const actions = message.actions ?? {}
  for (const t of tokens) {
    if (t.kind !== "action") continue
    if (actions[t.actionId]) continue
    console.warn("[chat] orphan action marker — no matching payload", {
      messageId: message.id,
      sessionId: message.sessionId,
      actionKind: t.actionKind,
      actionId: t.actionId,
    })
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Store                                    */
/* -------------------------------------------------------------------------- */

/**
 * Owns the chat tab's reactive state and dispatches workflow verbs to
 * the use-cases in `@lib/application/chat`.
 *
 * The store does NOT touch SQL or HTTP directly — it constructs the
 * SQL repos + HTTP wrappers lazily from `useLectorium()` and feeds them
 * into use-cases. This keeps the layering rule satisfied (presentation
 * → use-case → repo/service ports) and makes `sendMessage` testable by
 * stubbing `runChatTurn`.
 */
export const useChatStore = defineStore("chat", () => {
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const trackUserState = useTrackUserState()
  const playlist = usePlaylistStore()
  const toast = useToast()
  const { t } = useI18n()

  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const sending = ref<boolean>(false)
  const lastError = ref<{ code: string; message: string; retryAfter?: number } | null>(null)
  /** Session ids holding at least one proactive_state row in
   *  ready/degraded with `seen_at IS NULL`. Drives both the per-session
   *  dot in RecentSessions / history list AND the tab-level Sadhu badge
   *  (badge lights up iff this set is non-empty). Cleared per-session
   *  when `openSession(id)` stamps `seen_at`. */
  const unseenProactiveSessionIds = ref<ReadonlySet<string>>(new Set())

  let abort: AbortController | null = null

  function userDb() {
    const db = app.databases.user
    if (!db) throw new Error("chat-store: user DB is not open yet")
    return db
  }

  function chatRepos() {
    const userDatabase = userDb()
    return {
      sessions: createSqlChatSessionRepository(userDatabase),
      messages: createSqlChatMessageRepository(userDatabase),
    }
  }

  function streamClient() {
    return createHttpChatStreamClient()
  }
  function titleService() {
    return createHttpChatTitleService()
  }

  async function refreshSessions(): Promise<void> {
    const repos = chatRepos()
    const rows = await repos.sessions.list(200)
    sessions.value = rows.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
    // Repopulate the per-session "unseen" set. Best-effort — the
    // proactive repo lives in the same DB so a successful sessions list
    // pretty much guarantees this works, but if it fails we leave the
    // previous set in place rather than throw.
    try {
      const ids = await app.repositories().proactiveState.listUnseenSessionIds()
      unseenProactiveSessionIds.value = new Set(ids)
    } catch {
      // proactiveState repo not ready — leave previous set.
    }
  }

  async function openSession(id: string): Promise<void> {
    activeSessionId.value = id
    const repos = chatRepos()
    const rows = await repos.messages.listBySession(id as ChatSessionId)
    messages.value = rows.map((m) => ({ ...m }))
    // Opening a session counts as "the user saw any proactive messages
    // in it". Drop the session from the in-memory unseen set first
    // (so the dot disappears immediately, no roundtrip wait) and stamp
    // seen_at in SQL best-effort so the next refreshSessions agrees.
    if (unseenProactiveSessionIds.value.has(id)) {
      const next = new Set(unseenProactiveSessionIds.value)
      next.delete(id)
      unseenProactiveSessionIds.value = next
    }
    try {
      await app
        .repositories()
        .proactiveState.markSeen(id as ChatSessionId, Math.floor(Date.now() / 1000))
    } catch {
      // proactiveState repo not ready — fine, refreshSessions will
      // catch up later. Worst case the dot reappears briefly.
    }
  }

  function startNewSession(): void {
    if (sending.value) cancelStream()
    activeSessionId.value = null
    messages.value = []
    lastError.value = null
  }

  async function ensureActiveSession(seedTitle: string): Promise<string> {
    if (activeSessionId.value) return activeSessionId.value
    const repos = chatRepos()
    const id = randomId() as ChatSessionId
    const created = await repos.sessions.create({ id, title: deriveTitle(seedTitle) })
    activeSessionId.value = id
    sessions.value = [created, ...sessions.value]
    return id
  }

  async function sendMessage(
    text: string,
    options?: { focus?: FocusFragmentPayload }
  ): Promise<void> {
    const clean = text.trim()
    if (!clean || sending.value) return
    lastError.value = null
    sending.value = true

    const sessionId = (await ensureActiveSession(clean)) as ChatSessionId
    abort = new AbortController()
    const repos = chatRepos()

    // Snapshot history BEFORE we add the new turn so the server doesn't
    // see its own optimistic placeholder.
    const lang: "ru" | "en" = appLanguage.value.startsWith("en") ? "en" : "ru"
    const history: ChatTurn[] = messages.value
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }))

    let assistantMsgId: ChatMessageId | null = null
    let acc = ""

    try {
      const isFirst =
        messages.value.filter((m) => m.role === "assistant" && !m.streaming).length === 0
      for await (const event of runChatTurn(
        {
          sessionId,
          text: clean,
          lang,
          history,
          focus: options?.focus,
          isFirstAssistantTurn: isFirst,
          newMessageId: () => randomId() as ChatMessageId,
          signal: abort.signal,
        },
        {
          sessions: repos.sessions,
          messages: repos.messages,
          stream: streamClient(),
          title: titleService(),
          buildUserContext: (focus) => trackUserState.buildUserContext(focus),
          extractFollowups,
        }
      )) {
        applyTurnEvent(event)
        if (event.kind === "user-message") {
          // session list re-order
          const idx = sessions.value.findIndex((s) => s.id === sessionId)
          if (idx >= 0) {
            const updated = { ...sessions.value[idx], updatedAt: Date.now() }
            sessions.value = [updated, ...sessions.value.filter((_, i) => i !== idx)]
          }
          // No need to touch the unseen set here — sending a message
          // implies the user has the session open, and `openSession`
          // already cleared seen_at. Replying is no longer the trigger.
        }
        if (event.kind === "assistant-placeholder") assistantMsgId = event.messageId
        if (event.kind === "delta") acc += event.text
        if (event.kind === "tool-start") acc = ""
      }
    } catch (err) {
      lastError.value = {
        code: "stream",
        message: err instanceof Error ? err.message : "Stream failed",
      }
    } finally {
      abort = null
      sending.value = false
      // If the assistant bubble was never finalised (e.g. abort mid-stream),
      // drop the streaming placeholder so the UI doesn't keep its spinner.
      if (assistantMsgId) {
        const idx = messages.value.findIndex((m) => m.id === assistantMsgId)
        if (idx >= 0 && messages.value[idx].streaming) {
          if (acc.length === 0) {
            messages.value = messages.value.filter((m) => m.id !== assistantMsgId)
          }
        }
      }
    }
  }

  function applyTurnEvent(event: RunChatTurnEvent): void {
    switch (event.kind) {
      case "user-message":
        messages.value = [...messages.value, event.message]
        return
      case "assistant-placeholder": {
        const placeholder: ChatMessage = {
          id: event.messageId,
          sessionId: (activeSessionId.value ?? "") as ChatSessionId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          streaming: true,
        }
        messages.value = [...messages.value, placeholder]
        return
      }
      case "delta": {
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        next[idx] = { ...next[idx], content: next[idx].content + event.text }
        messages.value = next
        return
      }
      case "tool-start": {
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        next[idx] = { ...next[idx], content: "" }
        messages.value = next
        return
      }
      case "action": {
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        const cur = next[idx]
        next[idx] = {
          ...cur,
          actions: { ...(cur.actions ?? {}), [event.actionId]: event.payload },
        }
        messages.value = next
        return
      }
      case "outline": {
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        const cur = next[idx]
        next[idx] = {
          ...cur,
          outlines: { ...(cur.outlines ?? {}), [event.trackId]: event.payload },
        }
        messages.value = next
        return
      }
      case "finalised": {
        // Replace the streaming placeholder with the persisted entity.
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) {
          messages.value = [...messages.value, { ...event.message }]
        } else {
          const next = [...messages.value]
          next[idx] = { ...event.message }
          messages.value = next
        }
        // Cross-channel cooldown: only AFTER the chat_message has been
        // persisted do we attach the proactive_state sidecar for any
        // hint-class action the LLM emitted inline. Recording earlier
        // (on the `action` SSE event) creates a row whose FK points
        // to a not-yet-existing chat_messages.id — if the stream
        // aborts before `finalised`, the row becomes a permanent
        // orphan. `upgrade_to_pro` has no autonomous-rule counterpart,
        // so it's skipped by `inlineHintToRuleKind`.
        for (const action of Object.values(event.message.actions ?? {})) {
          void recordInlineHintCooldown(event.message.id, action)
        }
        // Visibility for orphan action markers: any `[action:...|id=X]`
        // in the finalised prose whose id has no matching payload will
        // render the broken-card placeholder. Log so we can grep for
        // residual LLM marker/payload-id drift after the agent-side
        // tool-call validation lands.
        warnOrphanActionMarkers(event.message)
        return
      }
      case "title-updated": {
        const sid = activeSessionId.value
        if (!sid) return
        const i = sessions.value.findIndex((s) => s.id === sid)
        if (i < 0) return
        const next = [...sessions.value]
        next[i] = { ...next[i], title: event.title }
        sessions.value = next
        return
      }
      case "error": {
        lastError.value = {
          code: event.code,
          message: event.message,
          retryAfter: event.retryAfter,
        }
        // Drop the empty placeholder — the toast / banner conveys failure.
        messages.value = messages.value.filter((m) => !m.streaming)
        return
      }
    }
  }

  function cancelStream(): void {
    if (abort) abort.abort()
    abort = null
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
    try {
      await chatRepos().messages.updateActionStates(messageId as ChatMessageId, actionStates)
    } catch (err) {
      console.warn("chat: failed to persist action state", err)
    }
  }

  async function executeAction(
    messageId: string,
    actionId: string,
    override?: { time?: string }
  ): Promise<void> {
    const msg = messages.value.find((m) => m.id === messageId)
    if (!msg) return
    const action = msg.actions?.[actionId]
    if (!action) return
    const currentState = msg.actionStates?.[actionId] ?? "pending"
    if (currentState === "executing" || currentState === "done") return

    await setActionState(messageId, actionId, "executing")
    try {
      if (action.kind === "create_playlist") {
        const r = await addTracksToPlaylist(
          { trackIds: action.trackIds as readonly TrackId[] },
          {
            playlist: {
              add: (id) => playlist.add(id as TrackId) as unknown as Promise<unknown>,
            },
          }
        )
        if (!r.ok) throw new Error(`add to playlist failed: ${r.error}`)
      } else if (action.kind === "enable_daily_reminder") {
        // Card lets the user pick a time before tapping Confirm; if
        // they did, the chosen value rides in via `override.time`.
        await applyProactiveDailyReminder(override?.time ?? action.time)
      } else if (action.kind === "configure_smart_library") {
        await applyProactiveSmartLibrary(action.filters)
      } else if (action.kind === "upgrade_to_pro") {
        // The paywall store handles its own dialog mounting; we just
        // request open and pretend the action completed (the user will
        // engage or dismiss the paywall separately).
        const { usePaywallStore } = await import("@lectorium/stores/usePaywallStore.js")
        usePaywallStore().requestOpen()
      } else if (action.kind === "queue_next_track") {
        const r = await playlist.add(action.trackId as TrackId)
        if (!r.ok && r.error !== "already-in-playlist") {
          throw new Error(`queue next failed: ${r.error}`)
        }
      }
      await setActionState(messageId, actionId, "done")
    } catch (err) {
      console.warn("chat: action execution failed", err)
      await setActionState(messageId, actionId, "error")
    }
  }

  async function recordInlineHintCooldown(
    chatMessageId: string,
    payload: ChatActionPayload
  ): Promise<void> {
    const ruleKind = inlineHintToRuleKind(payload.kind)
    if (ruleKind === null) return
    try {
      const repo = app.repositories().proactiveState
      const today = new Date()
      const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
      const ruleDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
      await repo.attach(
        chatMessageId as ChatMessageId,
        ruleKind,
        ruleDate,
        "ready",
        Math.floor(Date.now() / 1000)
      )
    } catch (err) {
      // Best-effort — if attach fails the user still sees the inline
      // card, just the autonomous tutorial may double up next month.
      console.debug("[proactive] inline hint attach failed:", err)
    }
  }

  function inlineHintToRuleKind(
    kind: ChatActionPayload["kind"]
  ): "enable_notifications_hint" | "smart_library_hint" | null {
    if (kind === "enable_daily_reminder") return "enable_notifications_hint"
    if (kind === "configure_smart_library") return "smart_library_hint"
    // `upgrade_to_pro` has no autonomous-rule counterpart today.
    return null
  }

  async function applyProactiveDailyReminder(time: string): Promise<void> {
    // Mirrors the Settings binding (`SettingsView.controller.ts`):
    // persist the enabled + time prefs the user-facing toggle reads
    // from, then re-arm the alarm via the shared composable. The
    // controller's watch picks this up too so opening Settings later
    // shows the same on/time state.
    // Bounded HH:mm — 00..23 hours, 00..59 minutes. The earlier
    // `\d{1,2}:\d{2}` form accepted nonsense like `25:99` and threw
    // downstream when `setHours(25, 99)` ran.
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time)
    if (!m) throw new Error(`enable_daily_reminder: invalid time '${time}'`)
    const hour = Number(m[1])
    const minute = Number(m[2])
    const { useConfig } = await import("@lectorium/composables/useConfig.js")
    const enabled = useConfig<boolean>("settings.notificationsEnabled", false)
    const timeRef = useConfig<[number, number] | undefined>("settings.notificationsTime", undefined)
    enabled.value = true
    timeRef.value = [hour, minute]
    await applyDailyReminder(
      {
        enabled: true,
        time,
        title: t("app.title"),
        body: t("notifications.timeToListen"),
      },
      { notifications: app.notifications }
    )
  }

  async function applyProactiveSmartLibrary(filters: SmartLibraryFiltersPayload): Promise<void> {
    const { usePurchasesStore } = await import("@lectorium/stores/usePurchasesStore.js")
    const purchases = usePurchasesStore()
    if (!purchases.isSubscribed) {
      // Not subscribed → bounce through the paywall. The user can
      // re-tap the same card after they upgrade.
      const { usePaywallStore } = await import("@lectorium/stores/usePaywallStore.js")
      usePaywallStore().requestOpen()
      return
    }
    const { useAutoDownloadFiltersStore } =
      await import("@lectorium/stores/useAutoDownloadFiltersStore.js")
    const store = useAutoDownloadFiltersStore()
    await store.load()
    if (filters.authorIds) await store.setAuthors(filters.authorIds)
    if (filters.tagIds) await store.setTags(filters.tagIds)
    if (filters.sourceIds) await store.setSources(filters.sourceIds)
    if (filters.locationIds) await store.setLocations(filters.locationIds)
    if (filters.languageCodes) await store.setLanguages(filters.languageCodes)
  }

  async function deleteSession(id: string): Promise<void> {
    const repos = chatRepos()
    await repos.messages.deleteBySession(id as ChatSessionId)
    await repos.sessions.delete(id as ChatSessionId)
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
    const repos = chatRepos()
    await repos.messages.clearAll()
    await repos.sessions.clearAll()
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
    unseenProactiveSessionIds,
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

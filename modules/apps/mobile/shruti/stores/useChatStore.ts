import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import {
  useTrackUserState,
  type FocusFragmentPayload,
} from "@shruti/composables/useTrackUserState.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useVerseBodyStore } from "@shruti/stores/useVerseBodyStore.js"
import { applyDailyReminder } from "@shruti/composables/useDailyReminder.js"
import {
  extractFollowups,
  parseChatMarkers,
} from "@shruti/views/Chat/composables/useMarkerParser.js"
import { runChatTurn, type RunChatTurnEvent } from "@lib/application"
import type {
  ChatActionPayload,
  ChatActionState,
  ChatFocusPayload,
  ChatMessage as DomainChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
  ChatSession as DomainChatSession,
  SmartLibraryFiltersPayload,
} from "@lib/domain"
import type { ChatMessageId, ChatSessionId, TrackId } from "@lib/domain/core.js"
import { createHttpChatStreamClient } from "@shruti/services/chat/httpChatStreamClient.js"
import { createHttpChatTitleService } from "@shruti/services/chat/httpChatTitleService.js"
import { createHttpChatQuestionsService } from "@shruti/services/chat/httpChatQuestionsService.js"
import {
  createSqlChatSessionRepository,
  createSqlChatMessageRepository,
} from "@infra/repositories/sql/index.js"
import type { ChatTurn } from "@ports/app/index.js"

/* -------------------------------------------------------------------------- */
/*                                  Domain                                    */
/* -------------------------------------------------------------------------- */

// Re-export domain types so consumers can keep importing them from
// `@shruti/stores/useChatStore` (the legacy path) while the
// canonical declarations live in `@lib/domain`.
export type ChatSession = DomainChatSession
export type ChatResearchSource = {
  readonly sourceKind: "verse" | "lecture_chunk" | "library_doc"
  readonly label: string
}
export type ChatMessage = DomainChatMessage & {
  streaming?: boolean
  /** Ephemeral i18n status key (e.g. "searching_corpus") set on the
   *  streaming bubble while the server is mid-turn; cleared on
   *  `finalised`. UI maps to a localized label via
   *  `t(`chat.status.${statusKey}`, params)`. */
  statusKey?: string
  statusParams?: Readonly<Record<string, string | number>>
  /** Ephemeral list of sub-queries the research pipeline generated for
   *  this turn. Append-only during the stream, dropped when the prose
   *  deltas start landing — same lifetime as `statusKey`. */
  researchQuestions?: readonly string[]
  /** Ephemeral map of sources the pipeline is inspecting right now.
   *  Keyed by the server-supplied stable id so multiple emissions of
   *  the same source (from different sub-queries) collapse into one
   *  chip. Cleared with the other research-* fields on the same
   *  trigger as `statusKey`. */
  researchSources?: ReadonlyMap<string, ChatResearchSource>
}
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
 * SQL repos + HTTP wrappers lazily from `useShruti()` and feeds them
 * into use-cases. This keeps the layering rule satisfied (presentation
 * → use-case → repo/service ports) and makes `sendMessage` testable by
 * stubbing `runChatTurn`.
 */
export const useChatStore = defineStore("chat", () => {
  const app = useShruti()
  const appLanguage = useAppLanguage()
  const trackUserState = useTrackUserState()
  const playlist = usePlaylistStore()
  const verseBodyStore = useVerseBodyStore()
  const { t } = useI18n()

  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const sending = ref<boolean>(false)
  /** Session ids holding at least one proactive_state row in
   *  ready/degraded with `seen_at IS NULL`. Drives both the per-session
   *  dot in RecentSessions / history list AND the tab-level Sadhu badge
   *  (badge lights up iff this set is non-empty). Cleared per-session
   *  when `openSession(id)` stamps `seen_at`. */
  const unseenProactiveSessionIds = ref<ReadonlySet<string>>(new Set())
  /** Set of focus message ids whose `/questions` round-trip is
   *  in-flight. Drives the per-card "Picking questions…" placeholder.
   *  The actual chip texts ride on the message's `followups` field —
   *  persisted via `updateFollowups`, survives a session reload. */
  const loadingFocusIds = ref<ReadonlySet<string>>(new Set())
  /** Bumped by the "Ask Sadhu" controller after a focus message is
   *  appended + navigation is queued. ChatView watches this counter
   *  and calls `inputBarRef.focus()` so the keyboard comes up without
   *  the user having to tap the textarea after the router lands. */
  const inputFocusToken = ref<number>(0)
  /** Auto-derived ChatSession bound to `activeSessionId`. Drives the
   *  session header above the message list (track title / author /
   *  date) and any other code that needs to know whether the current
   *  session is anchored to a track. */
  const activeSession = computed<ChatSession | null>(() => {
    const id = activeSessionId.value
    if (!id) return null
    return sessions.value.find((s) => s.id === id) ?? null
  })

  let abort: AbortController | null = null
  let suggestionsAbort: AbortController | null = null

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
  function questionsService() {
    return createHttpChatQuestionsService()
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
    // No-op when the caller asks to open the already-active session.
    // The "Ask Sadhu" flow opens a focused session, appends a focus
    // message, starts a /questions fetch, then navigates — the router
    // watcher re-fires `openSession(activeSessionId)` after the push.
    // Without this guard, that second call would abort the in-flight
    // suggestions request and reload the message list redundantly.
    if (activeSessionId.value === id) return
    cancelSuggestions()
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
    cancelSuggestions()
    activeSessionId.value = null
    messages.value = []
  }

  /**
   * "Ask Sadhu" entry point — open the latest session anchored to
   * `trackId`, or create a fresh one if none exists. Multiple Sadhu-taps
   * from the same track end up in the SAME session (accumulating focus
   * messages), instead of spawning a dupe per fragment. Free-form chats
   * (`trackId === null`) are not touched.
   */
  async function openOrCreateFocusedSession(trackId: TrackId): Promise<ChatSessionId> {
    if (sending.value) cancelStream()
    cancelSuggestions()
    const repos = chatRepos()
    const existing = await repos.sessions.findLatestByTrack(trackId)
    if (existing) {
      await openSession(existing.id)
      return existing.id as ChatSessionId
    }
    const id = randomId() as ChatSessionId
    const created = await repos.sessions.create({ id, title: null, trackId })
    activeSessionId.value = id
    messages.value = []
    sessions.value = [created, ...sessions.value.filter((s) => s.id !== id)]
    return id
  }

  /**
   * Append a focus-marked user message to the active session. Goes
   * through the regular `chat_messages` table with `role: "user"` +
   * `meta.focus` payload — server sees it as a normal history turn;
   * the bubble renderer branches on `focus` to draw the full-width
   * focus card (player + quote) instead of a user bubble.
   *
   * NOT a chat turn — does NOT call the agent. The caller dispatches
   * `requestSuggestions(focus)` separately if it wants chips.
   */
  async function appendFocusMessage(focus: ChatFocusPayload): Promise<ChatMessageId> {
    const sessionId = activeSessionId.value
    if (!sessionId) {
      throw new Error(
        "appendFocusMessage: no active session — call openOrCreateFocusedSession first"
      )
    }
    const repos = chatRepos()
    const id = randomId() as ChatMessageId
    const createdAt = Date.now()
    const persisted = await repos.messages.create({
      id,
      sessionId: sessionId as ChatSessionId,
      role: "user",
      content: focus.text,
      createdAt,
      focus,
    })
    await repos.sessions.touch(sessionId as ChatSessionId, createdAt)
    // Move the session to the top of the history list (same dance as
    // `sendMessage`'s `user-message` branch).
    const idx = sessions.value.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      const updated = { ...sessions.value[idx], updatedAt: createdAt }
      sessions.value = [updated, ...sessions.value.filter((_, i) => i !== idx)]
    }
    messages.value = [...messages.value, { ...persisted }]
    return id
  }

  /**
   * Fire-and-forget request to `/questions` for the just-inserted focus
   * fragment. Populates `pendingSuggestions` on success; on any failure
   * the value stays `null` and the UI renders no chips. Auto-aborts if
   * the active session changes mid-flight (user switched away).
   */
  async function requestSuggestions(
    messageId: ChatMessageId,
    focus: ChatFocusPayload
  ): Promise<void> {
    cancelSuggestions()
    const lang: "ru" | "en" = appLanguage.value.startsWith("en") ? "en" : "ru"
    const ctl = new AbortController()
    suggestionsAbort = ctl
    const forSessionId = activeSessionId.value
    // Surface loading state immediately so the focus card shows the
    // "Picking questions…" placeholder instead of staying chip-less
    // during the round-trip.
    const nextLoading = new Set(loadingFocusIds.value)
    nextLoading.add(messageId)
    loadingFocusIds.value = nextLoading
    try {
      const result = await questionsService().fetchSuggestedQuestions(
        {
          trackId: focus.trackId,
          startMs: focus.startMs,
          endMs: focus.endMs,
          text: focus.text,
          sourceKey: focus.sourceKey,
          trackTitle: focus.trackTitle,
          authorName: focus.authorName,
          date: focus.date,
          location: focus.location,
        },
        lang,
        { signal: ctl.signal }
      )
      if (ctl.signal.aborted) return
      if (activeSessionId.value !== forSessionId) return
      // Persist on the focus message's `meta.followups` so the chips
      // survive a session reload. Stored as an empty array when the
      // server gave us nothing — the ChatFocusCard interprets `[]` as
      // "fetch resolved, fall back to the static i18n list".
      const persisted: readonly string[] = result.length > 0 ? [...result] : []
      try {
        await chatRepos().messages.updateFollowups(messageId, persisted)
      } catch (err) {
        console.warn("chat: failed to persist focus followups", err)
      }
      const idx = messages.value.findIndex((m) => m.id === messageId)
      if (idx >= 0) {
        const next = [...messages.value]
        next[idx] = { ...next[idx], followups: persisted }
        messages.value = next
      }
    } catch {
      // Service maps errors to []; this catch is defence-in-depth.
    } finally {
      if (suggestionsAbort === ctl) suggestionsAbort = null
      const after = new Set(loadingFocusIds.value)
      after.delete(messageId)
      loadingFocusIds.value = after
    }
  }

  function cancelSuggestions(): void {
    if (suggestionsAbort) {
      suggestionsAbort.abort()
      suggestionsAbort = null
    }
    if (loadingFocusIds.value.size > 0) {
      loadingFocusIds.value = new Set()
    }
  }

  /** Bump the focus-input ping. ChatView watches `inputFocusToken` and
   *  brings the textarea into focus on every increment. Idempotent —
   *  call as many times as needed; the watcher fires per increment. */
  function requestInputFocus(): void {
    inputFocusToken.value = (inputFocusToken.value + 1) % 1_000_000
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
    sending.value = true

    const sessionId = (await ensureActiveSession(clean)) as ChatSessionId
    abort = new AbortController()
    const repos = chatRepos()

    // Snapshot history BEFORE we add the new turn so the server doesn't
    // see its own optimistic placeholder. For assistant messages we
    // also ship the per-turn `aliases` map (server-minted integer→chunk
    // map) so the agent can fold this message's chip markers back into
    // numbered-ref form before the LLM sees them.
    const lang: "ru" | "en" = appLanguage.value.startsWith("en") ? "en" : "ru"
    const history: ChatTurn[] = messages.value
      .filter((m) => !m.streaming)
      .map((m) => {
        const turn: ChatTurn = { role: m.role, content: m.content }
        if (m.role === "assistant" && m.aliases && Object.keys(m.aliases).length > 0) {
          ;(turn as { aliases?: ChatTurn["aliases"] }).aliases = m.aliases
        }
        return turn
      })

    let assistantMsgId: ChatMessageId | null = null

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
      }
    } catch (err) {
      // Unexpected error escaping the for-await loop (runChatTurn catches
      // stream-side failures internally and yields them as `error` events,
      // so we rarely land here — but if applyTurnEvent or another folded
      // step throws, surface it through the same inline path so the user
      // sees a failed bubble + Retry instead of a silently vanishing
      // placeholder.
      const code = "stream"
      const message = err instanceof Error ? err.message : "Stream failed"
      applyTurnEvent({ kind: "error", code, message })
    } finally {
      abort = null
      sending.value = false
      // Abort path only: chatClient.ts swallows AbortError silently, so
      // no `error` event reached applyTurnEvent and the placeholder is
      // still streaming. Drop it so the spinner doesn't linger. (Real
      // errors are converted to failed-bubble by the error handler
      // above, which clears `streaming`, so this branch skips them.)
      if (assistantMsgId) {
        const idx = messages.value.findIndex((m) => m.id === assistantMsgId)
        if (idx >= 0 && messages.value[idx].streaming) {
          messages.value = messages.value.filter((m) => m.id !== assistantMsgId)
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
      case "status": {
        // i18n status key from the server (e.g. "searching_corpus",
        // "composing_answer"). Surfaced as `statusKey` on the streaming
        // bubble so StatusPill.vue can render the localized label
        // without polling.
        //
        // We also clear the accumulated `researchQuestions` /
        // `researchSources` here — each status event marks a new
        // pipeline epoch, and stale research items would otherwise
        // keep showing up in the ticker rotation after the server
        // moved on (e.g. when `composing_answer` lands, the user
        // doesn't want to keep seeing "природа buddhi" sub-queries).
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const next = [...messages.value]
        next[idx] = {
          ...next[idx],
          statusKey: event.statusKey,
          statusParams: event.params,
          researchQuestions: undefined,
          researchSources: undefined,
        }
        messages.value = next
        return
      }
      case "research-question": {
        // Append a sub-query the research pipeline just generated.
        // Ephemeral — lives on the streaming bubble only; dropped on
        // `finalised` (which replaces the whole message) or `error`
        // (which removes the placeholder).
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const cur = messages.value[idx]
        const next = [...messages.value]
        next[idx] = {
          ...cur,
          researchQuestions: [...(cur.researchQuestions ?? []), event.question],
        }
        messages.value = next
        return
      }
      case "research-source": {
        // Add (or replace, last-write-wins) one inspected source.
        // Dedup happens here — server emits per-query, multiple
        // sub-queries inspecting the same chunk collapse into one chip.
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx < 0) return
        const cur = messages.value[idx]
        const nextMap = new Map(cur.researchSources ?? new Map())
        nextMap.set(event.id, { sourceKind: event.sourceKind, label: event.label })
        const next = [...messages.value]
        next[idx] = { ...cur, researchSources: nextMap }
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
      case "verse-payload": {
        // Server-streamed verse body for one (source_id, tokens). The
        // store caches it (with persistence) so `VerseCard.vue`
        // can render the full block. Does NOT touch the message list
        // — verse-payload arrives BEFORE the prose deltas containing
        // the marker, and the marker itself is what triggers render.
        verseBodyStore.set(event.sourceId, event.tokens, {
          addrLabel: event.addrLabel,
          sanskrit: event.sanskrit,
          transliteration: event.transliteration,
          translation: event.translation,
        })
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
        // Convert relative `Retry-After` (seconds, only set on the 429
        // path inside chatClient.ts) into an absolute deadline at the
        // moment we receive it. Without this the bubble's countdown
        // would drift if the user backgrounds the app — relative-seconds
        // captured at this point would be stale on next render.
        const retryAfterAt: number | undefined =
          typeof event.retryAfter === "number" && event.retryAfter > 0
            ? Date.now() + event.retryAfter * 1000
            : undefined
        const failedErr: ChatMessageError = retryAfterAt
          ? { kind: "failed", code: event.code, retryAfterAt }
          : { kind: "failed", code: event.code }
        // Transform the streaming placeholder into a failed-bubble in
        // place — keeps the message slot's id stable (handy for any
        // scroll/anchor logic) and avoids the placeholder briefly
        // vanishing before the failure appears. Failed bubbles stay
        // in-memory only: they're not useful history and the SQL
        // `parseError` whitelist would discard the `failed` kind on
        // reload anyway.
        const idx = messages.value.findIndex((m) => m.streaming)
        if (idx >= 0) {
          const next = [...messages.value]
          next[idx] = {
            ...next[idx],
            streaming: false,
            content: "",
            statusKey: undefined,
            statusParams: undefined,
            error: failedErr,
          }
          messages.value = next
        } else {
          // No streaming placeholder (error fired before
          // `assistant-placeholder` was yielded — rare; happens if the
          // pre-stream fetch itself errors and the iterator bails
          // before runChatTurn's first yield reaches us). Synthesize
          // an inline failed assistant row so the user still sees the
          // failure attached to the turn they just sent.
          messages.value = [
            ...messages.value,
            {
              id: randomId() as ChatMessageId,
              sessionId: (activeSessionId.value ?? "") as ChatSessionId,
              role: "assistant",
              content: "",
              createdAt: Date.now(),
              error: failedErr,
            },
          ]
        }
        return
      }
    }
  }

  function cancelStream(): void {
    if (abort) abort.abort()
    abort = null
  }

  /**
   * Retry the assistant reply for the last failed turn. Locates the
   * assistant message carrying an error marker (`failed` or
   * `truncated`) — either by id, or the most recent one if no id is
   * passed — drops both it AND the user prompt that produced it from
   * memory + DB, then re-sends the same user text as a fresh turn.
   *
   * Deleting the user row first keeps the DB from accumulating a long
   * tail of repeat-prompts every time the user hammers Retry while
   * the network is flaky; the fresh `sendMessage(text)` call below
   * will persist a new user message via runChatTurn anyway, so net
   * effect after a successful retry is one user + one assistant row
   * per turn.
   *
   * `failed` bubbles live in memory only (the SQL repo's `parseError`
   * whitelist filters them out on reload), so deleting them from the
   * DB is a no-op for that variant — but the call is cheap and keeps
   * one code path for both `failed` and `truncated`.
   */
  async function retryLast(messageId?: string): Promise<void> {
    if (sending.value) return
    const all = messages.value
    let assistantIdx = -1
    if (messageId) {
      assistantIdx = all.findIndex((m) => m.id === messageId)
    } else {
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].role === "assistant" && all[i].error) {
          assistantIdx = i
          break
        }
      }
    }
    if (assistantIdx < 0) return
    const assistant = all[assistantIdx]
    if (assistant.role !== "assistant" || !assistant.error) return

    // Walk back to the user prompt that produced this assistant reply.
    let userIdx = -1
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (all[i].role === "user") {
        userIdx = i
        break
      }
    }
    if (userIdx < 0) return
    const userMsg = all[userIdx]
    const userText = userMsg.content

    messages.value = all.filter((_, i) => i !== assistantIdx && i !== userIdx)
    const repos = chatRepos()
    try {
      await repos.messages.delete(userMsg.id as ChatMessageId)
    } catch (err) {
      console.warn("chat: failed to delete prior user message on retry", err)
    }
    try {
      await repos.messages.delete(assistant.id as ChatMessageId)
    } catch (err) {
      console.warn("chat: failed to delete failed assistant on retry", err)
    }

    await sendMessage(userText)
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
      if (action.kind === "enable_daily_reminder") {
        // Card lets the user pick a time before tapping Confirm; if
        // they did, the chosen value rides in via `override.time`.
        await applyProactiveDailyReminder(override?.time ?? action.time)
      } else if (action.kind === "configure_smart_library") {
        await applyProactiveSmartLibrary(action.filters)
      } else if (action.kind === "upgrade_to_pro") {
        // The paywall store handles its own dialog mounting; we just
        // request open and pretend the action completed (the user will
        // engage or dismiss the paywall separately).
        const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
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
    const { useConfig } = await import("@shruti/composables/useConfig.js")
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
    const { usePurchasesStore } = await import("@shruti/stores/usePurchasesStore.js")
    const purchases = usePurchasesStore()
    if (!purchases.isSubscribed) {
      // Not subscribed → bounce through the paywall. The user can
      // re-tap the same card after they upgrade.
      const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
      usePaywallStore().requestOpen()
      return
    }
    const { useAutoDownloadFiltersStore } =
      await import("@shruti/stores/useAutoDownloadFiltersStore.js")
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
    cancelSuggestions()
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
    activeSession,
    activeSessionId,
    messages,
    sending,
    loadingFocusIds,
    inputFocusToken,
    unseenProactiveSessionIds,
    refreshSessions,
    openSession,
    openOrCreateFocusedSession,
    appendFocusMessage,
    requestSuggestions,
    requestInputFocus,
    startNewSession,
    sendMessage,
    cancelStream,
    retryLast,
    executeAction,
    deleteSession,
    clearAll,
    searchSessions,
  }
})

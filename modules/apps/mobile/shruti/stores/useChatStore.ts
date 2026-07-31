import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"
import { useNow } from "@vueuse/core"
import { toastController } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { emitTurnSettled, emitTurnStarted } from "@shruti/chat/turnNotificationEvents.js"
import { applyStreamingTurnEvent } from "@shruti/stores/chatTurnReducer.js"
import { createPendingTurnStore, type PendingTurn } from "@shruti/stores/chatPendingTurns.js"
import { useToast } from "@kit/composables"
import { openStorePage } from "@shruti/utils/openStorePage.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import {
  useChatLanguage,
  useChatTranslateCitations,
} from "@shruti/composables/useChatLanguage.js"
import {
  useTrackUserState,
  type FocusFragmentPayload,
} from "@shruti/composables/useTrackUserState.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import { applyDailyReminder } from "@shruti/composables/useDailyReminder.js"
import { extractFollowups } from "@lib/chat/chatMarkers.js"
import {
  recordInlineHintCooldown as recordInlineHintCooldownUC,
  replayChatTurn,
  runChatTurn,
  submitChatFeedback,
  type RunChatTurnEvent,
} from "@usecases"
import type {
  ChatActionPayload,
  ChatActionState,
  ChatFocusPayload,
  ChatMessage as DomainChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
  ChatSession as DomainChatSession,
  QuotaTier,
  SmartLibraryFiltersPayload,
} from "@lib/domain"
import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId, TrackId } from "@lib/domain/core.js"
import type { ChatStreamEvent, ChatTurn, FeedbackCategory } from "@lib/contracts"

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
/** Interpolation values for a status i18n key — e.g. `{ intent: "research" }`
 *  for `chat.status.router_decision`. */
export type ChatStatusParams = Readonly<Record<string, string | number>>
export type ChatMessage = DomainChatMessage & {
  streaming?: boolean
  /** Ephemeral i18n status key (e.g. "searching_corpus") set on the
   *  streaming bubble while the server is mid-turn; cleared on
   *  `finalised`. UI maps to a localized label via
   *  `t(`chat.status.${statusKey}`, params)`. */
  statusKey?: string
  statusParams?: ChatStatusParams
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

/** Narrow the server's `tier` string ("anonymous" | "free" | "pro")
 *  into the typed union. Anything else (typo, future tier we don't know
 *  about yet, missing field) collapses to undefined so the UI falls
 *  back to a tier-agnostic message. */
function parseQuotaTier(raw: string | undefined): QuotaTier | undefined {
  if (raw === "anonymous" || raw === "free" || raw === "pro") return raw
  return undefined
}

/* -------------------------------------------------------------------------- */
/*                                   Store                                    */
/* -------------------------------------------------------------------------- */

/**
 * Owns the chat tab's reactive state and dispatches workflow verbs to
 * the use-cases in `@usecases/chat`.
 *
 * The store does NOT touch SQL or HTTP directly — it pulls the repos +
 * chat service adapters off `useShruti()` (built by the composition
 * root) and feeds them into use-cases. This keeps the layering rule
 * satisfied (presentation → use-case → repo/service ports) and makes
 * `sendMessage` testable by stubbing `runChatTurn`.
 */
export const useChatStore = defineStore("chat", () => {
  const app = useShruti()
  const appLanguage = useAppLanguage()
  const chatLanguage = useChatLanguage()
  const chatTranslateCitations = useChatTranslateCitations()
  const trackUserState = useTrackUserState()
  const playlist = usePlaylistStore()
  const { t } = useI18n()
  const toast = useToast()

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
  /** UnixMs deadline until which the chat composer stays disabled
   *  after a `rate_limited` 429. Set from the server's `resets_at_epoch`
   *  (or `Retry-After` as fallback). Lives in-memory only — a cold
   *  restart drops it so a server-side limit change (admin reset,
   *  Redis flush, manual TTL bump) is reflected on the next send
   *  attempt. The "free" send-then-429 cycle that earned a user a
   *  re-armed lockout is a tiny cost (one rejected request) compared
   *  to trapping the user behind a stale persisted deadline they have
   *  no way to clear from the UI. */
  const composeBlockedUntil = ref<number | null>(null)
  /** Per-day chat usage snapshot, populated by the server's SSE `usage`
   *  event (every successful turn) or by a `rate_limited` error body
   *  (when `key_type === "user"`). Drives the usage chip above the
   *  composer. `null` means "we haven't seen the server yet" — chip
   *  stays hidden. Persisted under `chat_usage:<quota_id>` so a cold
   *  start mid-day re-hydrates without waiting for the next turn —
   *  unlike `composeBlockedUntil` (intentionally in-memory only), the
   *  chip is a read-only display of a counter the server controls, so
   *  there's no "stale state traps the user" failure mode to fear. */
  const chatUsage = ref<{ current: number; limit: number; resetsAtEpoch: number } | null>(null)

  /** Pref key for the persisted usage snapshot. Keyed by quota_id so
   *  separate identities don't bleed into each other; empty qid =
   *  no persistence (in-memory only). */
  const USAGE_KEY_PREFIX = "chat_usage:"
  function usageKey(qid: string): string {
    return `${USAGE_KEY_PREFIX}${qid}`
  }

  /** Read back the persisted usage snapshot for `qid` and arm
   *  `chatUsage` if `resetsAtEpoch` is still in the future. Stale
   *  entries (the day rolled over since they were written) are wiped
   *  so the chip doesn't briefly render a 100%-but-already-reset state.
   *  Malformed payloads are tolerated — anything that doesn't parse is
   *  treated as "no usage snapshot". */
  async function hydrateChatUsage(qid: string): Promise<void> {
    if (!qid) {
      // No stable bucket id — clear in-memory so the chip doesn't carry
      // over from a previous identity.
      chatUsage.value = null
      return
    }
    const key = usageKey(qid)
    try {
      const raw = await app.preferences.get(key)
      if (raw === null) {
        chatUsage.value = null
        return
      }
      const parsed = JSON.parse(raw) as {
        current?: unknown
        limit?: unknown
        resetsAtEpoch?: unknown
      }
      const current = typeof parsed.current === "number" ? parsed.current : -1
      const limit = typeof parsed.limit === "number" ? parsed.limit : -1
      const resetsAtEpoch = typeof parsed.resetsAtEpoch === "number" ? parsed.resetsAtEpoch : -1
      if (current < 0 || limit <= 0 || resetsAtEpoch <= 0) {
        await app.preferences.remove(key)
        chatUsage.value = null
        return
      }
      if (resetsAtEpoch * 1000 > Date.now()) {
        chatUsage.value = { current, limit, resetsAtEpoch }
      } else {
        // Reset boundary already passed — drop the stale entry.
        await app.preferences.remove(key)
        chatUsage.value = null
      }
    } catch (e) {
      console.warn("[chat] failed to hydrate chat usage", e)
      chatUsage.value = null
    }
  }

  /** Write the in-memory `chatUsage` to Preferences under the supplied
   *  quota_id. No-op when qid is empty (pre-PR-1 anon tokens with no
   *  stable bucket — chip stays in-memory only). Fire-and-forget — a
   *  storage hiccup shouldn't sink the streaming turn. */
  function persistChatUsage(qid: string): void {
    if (!qid) return
    const snap = chatUsage.value
    if (snap === null) {
      void app.preferences.remove(usageKey(qid)).catch((e) => {
        console.warn("[chat] failed to clear chat usage key", e)
      })
      return
    }
    void app.preferences.set(usageKey(qid), JSON.stringify(snap)).catch((e) => {
      console.warn("[chat] failed to persist chat usage", e)
    })
  }
  /** Reactive clock for `isComposeBlocked` — ticks every second while
   *  any consumer subscribes. @vueuse handles the timer lifecycle
   *  (visibility-aware, cleaned up on unmount). */
  const now = useNow({ interval: 1000 })
  const isComposeBlocked = computed<boolean>(
    () => composeBlockedUntil.value !== null && now.value.getTime() < composeBlockedUntil.value
  )
  /** Drop the inline "limit exhausted" failed bubble from the current
   *  message list. Shared by `resetComposeLock` (identity flip) and the
   *  expiry watcher below (wall-clock crossed the deadline) — the bubble
   *  must die in lockstep with `composeBlockedUntil`, otherwise the
   *  upsell card lingers indefinitely after the limit has lifted and
   *  the user has no idea why the composer is back but the warning
   *  isn't. */
  function clearRateLimitedBubble(): void {
    const idx = messages.value.findIndex(
      (m) => m.role === "assistant" && m.error?.kind === "failed" && m.error.code === "rate_limited"
    )
    if (idx < 0) return
    const next = [...messages.value]
    next[idx] = { ...next[idx], error: undefined }
    messages.value = next
  }

  /** Clear the composer lockdown and wipe any stale rate_limit error
   *  bubble in the current message list. Called from `useAuthStore`'s
   *  `userId` watcher on signin / signout / switch-account, and from
   *  the `isPro` watcher on free→pro upgrade. Each identity has its
   *  own server-side quota bucket (`quota_id`), so the previous
   *  bucket's deadline + upsell banner are meaningless for the next
   *  one. */
  function resetComposeLock(): void {
    composeBlockedUntil.value = null
    clearRateLimitedBubble()
    // Per-identity hydration for the usage chip — each quota_id has
    // its own daily counter on the server, so the previous identity's
    // snapshot shouldn't bleed into this one's chip. Empty qid (pre-
    // PR-1 anon tokens still in flight) clears the in-memory snapshot
    // inside `hydrateChatUsage`.
    const nextQuotaId = useAuthStore().quotaId
    void hydrateChatUsage(nextQuotaId)
  }

  /** Watch the wall-clock against the live deadline and drop the
   *  in-memory rate_limited failed bubble at the same edge as we
   *  clear the lockout. Without this, the composer unlocks but the
   *  error card would otherwise hang around until the next identity
   *  change or hard restart. */
  watch(
    () => composeBlockedUntil.value !== null && now.value.getTime() >= composeBlockedUntil.value,
    (expired, wasExpired) => {
      if (!expired || wasExpired) return
      composeBlockedUntil.value = null
      clearRateLimitedBubble()
    }
  )
  /** Auto-derived ChatSession bound to `activeSessionId`. Drives the
   *  session header above the message list (track title / author /
   *  date) and any other code that needs to know whether the current
   *  session is anchored to a track. */
  const activeSession = computed<ChatSession | null>(() => {
    const id = activeSessionId.value
    if (!id) return null
    return sessions.value.find((s) => s.id === id) ?? null
  })

  /** The session's own title, or null when it has none yet (a fresh focused
   *  session before its first reply). Used to label "answer ready"
   *  notifications so multiple chats are distinguishable. */
  function sessionTitleFor(sessionId: string): string | null {
    const title = sessions.value.find((s) => s.id === sessionId)?.title?.trim()
    return title ? title : null
  }

  /** In-flight chat turns keyed by sessionId. A turn keeps streaming even
   *  after the user navigates away from its session — we DETACH instead of
   *  aborting (openSession / startNewSession / Ask Sadhu used to call
   *  `cancelStream` here). `runChatTurn` persists the finalised reply to
   *  SQLite regardless of whether the UI is still consuming it, so the
   *  answer is never lost on a mid-stream session switch. The Stop button
   *  (`cancelStream`) only targets the active session's controller. */
  const turnControllers = new Map<string, AbortController>()
  let suggestionsAbort: AbortController | null = null

  /** Id of the assistant placeholder for the turn currently streaming.
   *  Pre-minted by `runChatTurn` and handed over on the
   *  `assistant-placeholder` event, so every streaming mutation can
   *  target THIS bubble by id instead of scanning for `m.streaming` —
   *  a stale placeholder (e.g. a previous turn that never cleared its
   *  flag) can't misroute deltas. Cleared on `finalised` / `error`. */
  let streamingMessageId: ChatMessageId | null = null

  /** Locate the current streaming bubble by its known id. Returns -1
   *  if there's no active stream or the bubble was dropped (session
   *  switch, retry). Callers bail on -1, same as the old
   *  `findIndex(m => m.streaming)` contract. */
  function streamingIndex(): number {
    if (streamingMessageId === null) return -1
    return messages.value.findIndex((m) => m.id === streamingMessageId)
  }

  // Chat repositories and HTTP service adapters are built by the
  // composition root (shruti.ts / repositories.ts). The store only
  // consumes them — it never instantiates concrete @infra adapters.
  function chatRepos() {
    const repos = app.repositories()
    return { sessions: repos.chatSessions, messages: repos.chatMessages }
  }

  function streamClient() {
    return app.chatStreamClient
  }
  function resumeService() {
    return app.chatResumeService
  }
  function titleService() {
    return app.chatTitleService
  }
  function questionsService() {
    return app.chatQuestionsService
  }
  function feedbackService() {
    return app.chatFeedbackService
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
      // Union with answered-while-away sessions (persisted) so the same
      // per-session dot + tab badge also light up when a chat reply lands
      // while the user isn't viewing it.
      const answers = await readUnreadAnswers()
      unseenProactiveSessionIds.value = new Set([...ids, ...answers])
    } catch {
      // proactiveState repo not ready — leave previous set.
    }
  }

  /* ---- Unread chat answers — badge for replies that arrived while away ---- */
  // The per-session dot + tab/inbox badge already render off
  // `unseenProactiveSessionIds`. A reply to the user's OWN question that
  // lands while they aren't viewing the session is surfaced the same way:
  // its id is merged into that set and persisted so the badge survives a
  // restart, and cleared when the session is opened.
  const UNREAD_ANSWERS_KEY = "chat:unread_answers"

  async function readUnreadAnswers(): Promise<string[]> {
    try {
      const raw = await app.preferences.get(UNREAD_ANSWERS_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as string[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function writeUnreadAnswers(ids: string[]): Promise<void> {
    try {
      if (ids.length === 0) await app.preferences.remove(UNREAD_ANSWERS_KEY)
      else await app.preferences.set(UNREAD_ANSWERS_KEY, JSON.stringify(ids))
    } catch {
      // best-effort — a failed persist just means weaker cross-restart badge
    }
  }

  /** Mark a session as having an unread answer (a reply landed while the user
   *  wasn't viewing it). Lights the dot + badge immediately and persists. */
  async function markAnswerUnread(sessionId: string): Promise<void> {
    if (!unseenProactiveSessionIds.value.has(sessionId)) {
      const next = new Set(unseenProactiveSessionIds.value)
      next.add(sessionId)
      unseenProactiveSessionIds.value = next
    }
    const ids = await readUnreadAnswers()
    if (!ids.includes(sessionId)) {
      ids.push(sessionId)
      await writeUnreadAnswers(ids)
    }
  }

  async function clearAnswerUnread(sessionId: string): Promise<void> {
    const ids = await readUnreadAnswers()
    const next = ids.filter((x) => x !== sessionId)
    if (next.length !== ids.length) await writeUnreadAnswers(next)
  }

  /* ---- Last-seen message per session — scroll anchor on reopen ---- */
  // We persist the id of the LAST message the user actually saw in each
  // session. On reopen the view anchors that message at the top, so anything
  // that arrived while they were away (a resumed answer, a proactive reply)
  // reads downward from its start instead of being scrolled past to the
  // bottom. This is a plain "last read message id", not a time- or
  // unread-flag heuristic. Map is sessionId → messageId.
  const LAST_SEEN_KEY = "chat:last_seen_message"

  async function readLastSeen(): Promise<Record<string, string>> {
    try {
      const raw = await app.preferences.get(LAST_SEEN_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Record<string, string>
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }

  /** Id of the last message the user saw in this session, or null if never
   *  opened. Read this BEFORE `openSession` to decide the scroll anchor. */
  async function getLastSeenMessageId(sessionId: string): Promise<string | null> {
    return (await readLastSeen())[sessionId] ?? null
  }

  /** Record that the user has seen `messageId` as the latest message in the
   *  session. Called by the view while the session is on screen — only with
   *  NON-streaming messages, so a streaming placeholder (which shares the
   *  final answer's id) never counts as "read" if the user leaves mid-turn. */
  async function markSessionSeen(sessionId: string, messageId: string): Promise<void> {
    const map = await readLastSeen()
    if (map[sessionId] === messageId) return
    map[sessionId] = messageId
    try {
      await app.preferences.set(LAST_SEEN_KEY, JSON.stringify(map))
    } catch {
      // best-effort — a failed persist just means weaker scroll anchoring
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
    // Switching away from a session mid-stream DETACHES its turn rather
    // than aborting it: the turn keeps streaming and `runChatTurn`
    // persists its finalised reply to the turn's own session in SQLite,
    // so navigating away no longer loses the answer. The consume loop's
    // session guard stops its events from leaking into the session we're
    // opening; `cancelSuggestions` still cancels the (unrelated)
    // suggestion fetch. The Stop button is the only explicit abort.
    cancelSuggestions()
    streamingMessageId = null
    activeSessionId.value = id
    syncComposeBusy()
    const repos = chatRepos()
    const rows = await repos.messages.listBySession(id as ChatSessionId)
    messages.value = rows.map((m) => ({ ...m }))
    // A turn for this session may still be in flight (its live stream kept
    // running after we navigated away, or it's resuming after a background).
    // Show the thinking indicator and — if no live stream owns it — kick a
    // resume poll so the answer (and the indicator) actually land.
    const inflight = (await readPending()).find((p) => p.sessionId === id)
    if (inflight) {
      ensureThinkingPlaceholder(id, inflight.assistantMessageId)
      if (!turnControllers.has(id)) void resumeOnePendingTurn(inflight)
    }
    // Opening a session counts as "the user saw any proactive messages
    // in it". Drop the session from the in-memory unseen set first
    // (so the dot disappears immediately, no roundtrip wait) and stamp
    // seen_at in SQL best-effort so the next refreshSessions agrees.
    if (unseenProactiveSessionIds.value.has(id)) {
      const next = new Set(unseenProactiveSessionIds.value)
      next.delete(id)
      unseenProactiveSessionIds.value = next
    }
    // Opening the session also clears its persisted unread-answer badge.
    void clearAnswerUnread(id)
    // Persist seen_at off the critical path — the in-memory set above
    // already cleared the dot instantly, and this write only needs to
    // survive a reload. NOT awaited so it never extends the session-open
    // window (the view keeps the scroller hidden until openSession
    // resolves). refreshSessions reconciles if it fails.
    void app
      .repositories()
      .proactiveState.markSeen(id as ChatSessionId, Math.floor(Date.now() / 1000))
      .catch(() => {
        // proactiveState repo not ready — refreshSessions catches up.
      })
  }

  function startNewSession(): void {
    // Detach (don't abort) any in-flight turn — it finishes and persists
    // to its own session. Starting a fresh chat just clears the view.
    cancelSuggestions()
    streamingMessageId = null
    activeSessionId.value = null
    messages.value = []
    sending.value = false
  }

  /**
   * "Ask Sadhu" entry point — open the latest session anchored to
   * `trackId`, or create a fresh one if none exists. Multiple Sadhu-taps
   * from the same track end up in the SAME session (accumulating focus
   * messages), instead of spawning a dupe per fragment. Free-form chats
   * (`trackId === null`) are not touched.
   */
  async function openOrCreateFocusedSession(trackId: TrackId): Promise<ChatSessionId> {
    // Detach (don't abort) any in-flight turn — see openSession.
    cancelSuggestions()
    const repos = chatRepos()
    const existing = await repos.sessions.findLatestByTrack(trackId)
    if (existing) {
      await openSession(existing.id)
      return existing.id as ChatSessionId
    }
    const id = randomId() as ChatSessionId
    const created = await repos.sessions.create({ id, title: null, trackId })
    streamingMessageId = null
    activeSessionId.value = id
    messages.value = []
    sessions.value = [created, ...sessions.value.filter((s) => s.id !== id)]
    syncComposeBusy()
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
    // Send the chosen chat locale verbatim (empty ⇒ follow the interface
    // language). The backend treats `lang` as an opaque prompt code.
    const lang = chatLanguage.value || appLanguage.value
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

  /** Drop any in-flight streaming placeholder from `messages`. Used by
   *  the typed-error branches in `sendMessage` — those errors aren't
   *  retryable at the bubble level (the user has to update the app or
   *  wait for the outage to clear), so leaving an empty failed bubble
   *  with a Retry button would be misleading. */
  function dropStreamingPlaceholder(): void {
    streamingMessageId = null
    if (messages.value.some((m) => m.streaming)) {
      messages.value = messages.value.filter((m) => !m.streaming)
    }
  }

  /** Present the "update required" toast with a one-tap CTA that
   *  opens the platform store. Built directly on `toastController` (not
   *  via `useToast`) because the wrapped helper only exposes text-only
   *  toasts; the CTA needs a `buttons` array on the Ionic toast. */
  async function showProtocolMismatchToast(): Promise<void> {
    const t1 = await toastController.create({
      message: `${t("chat.error.protocolMismatch.title")}: ${t("chat.error.protocolMismatch.body")}`,
      // Sticky (`duration: 0`) until the user dismisses or taps the
      // store button — the action is real and we don't want it to
      // slide off after 1.8s while they're scrolling.
      duration: 0,
      position: "top",
      color: "danger",
      buttons: [
        {
          text: t("chat.error.protocolMismatch.cta"),
          handler: () => {
            openStorePage()
          },
        },
        { text: "", role: "cancel", icon: "close" },
      ],
    })
    await t1.present()
  }

  async function sendMessage(
    text: string,
    options?: { focus?: FocusFragmentPayload }
  ): Promise<void> {
    const clean = text.trim()
    if (!clean || sending.value) return
    sending.value = true

    // Session creation + the user-message persist are local SQLite work,
    // so they run first and the user's bubble appears instantly. The auth
    // refresh (formerly awaited HERE, which blocked the bubble on a
    // network round-trip after a resume) now runs inside `runChatTurn`
    // right before the SSE stream opens — via the `ensureFresh` dep below.
    // Only the assistant reply waits on the network, never the user's
    // own message.
    const sessionId = (await ensureActiveSession(clean)) as ChatSessionId
    const controller = new AbortController()
    turnControllers.set(sessionId, controller)
    const repos = chatRepos()

    // Snapshot history BEFORE we add the new turn so the server doesn't
    // see its own optimistic placeholder. For assistant messages we
    // also ship the per-turn `aliases` map (server-minted integer→chunk
    // map) so the agent can fold this message's chip markers back into
    // numbered-ref form before the LLM sees them.
    // Send the chosen chat locale verbatim (empty ⇒ follow the interface
    // language). The backend treats `lang` as an opaque prompt code, so a
    // non-en/ru locale (uk/sr) is no longer collapsed to "ru".
    const lang = chatLanguage.value || appLanguage.value
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
    // Set when the live SSE socket dies mid-turn (typically the OS froze the
    // WebView on backgrounding). NOT a failure — the server keeps generating
    // and buffers the turn — so we suppress the error, keep the pending record
    // + thinking placeholder, and recover via the resume poll (see `finally`).
    let resumableDrop = false

    try {
      const isFirst =
        messages.value.filter((m) => m.role === "assistant" && !m.streaming).length === 0
      for await (const event of runChatTurn(
        {
          sessionId,
          sessionTitle: activeSession.value?.title ?? undefined,
          text: clean,
          lang,
          translateCitations: chatTranslateCitations.value,
          history,
          focus: options?.focus,
          isFirstAssistantTurn: isFirst,
          newMessageId: () => randomId() as ChatMessageId,
          signal: controller.signal,
        },
        {
          sessions: repos.sessions,
          messages: repos.messages,
          stream: streamClient(),
          title: titleService(),
          buildUserContext: (focus) => trackUserState.buildUserContext(focus),
          extractFollowups,
          // Refresh the auth claim inside the turn — after the user bubble
          // is shown, before the stream opens — so a tier flip that
          // happened while backgrounded rides this turn without delaying
          // the user's message. Best-effort; runChatTurn swallows errors.
          ensureFresh: () => useAuthStore().ensureFresh(),
        }
      )) {
        // Same unified reflection as the resume replay: caches always, the
        // view (incl. the streaming bubble) only when this turn's session is
        // on screen — so a session switch mid-stream can't leak a foreign
        // bubble into the open conversation, while verse/citation caches still
        // fill for the turn's own session.
        // A dropped connection — our SSE socket died after the server had
        // accepted the turn (typically the OS froze the WebView when the user
        // left) — is NOT a failure: the server keeps generating and buffers
        // the whole turn. Detect it and surface NOTHING — no "connection
        // dropped" bubble, no settle (which would cancel the pre-armed
        // notification), and crucially DON'T clear the pending record. The
        // `finally` below keeps the thinking placeholder and kicks the resume
        // poll, which replays the full buffered answer. Two shapes:
        //   • error code "stream" AFTER the placeholder (dropped before prose)
        //   • finalised carrying a truncated/"stream" marker (dropped mid-prose;
        //     runChatTurn already persisted a partial row — resume overwrites it)
        const isDropError = event.kind === "error" && event.code === "stream" && !!assistantMsgId
        const isDropFinalise =
          event.kind === "finalised" &&
          event.message.error?.kind === "truncated" &&
          event.message.error.reason === "stream"
        if (isDropError || isDropFinalise) {
          resumableDrop = true
          continue
        }

        reflectTurnEvent(event, sessionId)
        // App-level turn lifecycle — fires regardless of which page is on
        // screen (the loop lives in the singleton store, not the view), so the
        // answer notifies / badges / clears its pending record even after the
        // user navigates away from the session.
        if (event.kind === "assistant-placeholder") {
          assistantMsgId = event.messageId
          void addPending(event.messageId, sessionId)
          emitTurnStarted({ assistantMessageId: event.messageId, sessionId })
        }
        if (event.kind === "finalised") {
          void removePending(event.message.id)
          emitTurnSettled({ assistantMessageId: event.message.id, sessionId, ok: true })
        }
        if (event.kind === "error" && assistantMsgId) {
          void removePending(assistantMsgId)
          emitTurnSettled({ assistantMessageId: assistantMsgId, sessionId, ok: false })
        }
        if (event.kind === "user-message" && activeSessionId.value === sessionId) {
          // Session list re-order — view-scoped. No need to touch the unseen
          // set: sending implies the session is open and openSession cleared
          // seen_at.
          const idx = sessions.value.findIndex((s) => s.id === sessionId)
          if (idx >= 0) {
            const updated = { ...sessions.value[idx], updatedAt: Date.now() }
            sessions.value = [updated, ...sessions.value.filter((_, i) => i !== idx)]
          }
        }
      }
    } catch (err) {
      // Typed structural failures (426 protocol mismatch, 503 backend
      // unavailable) get a dedicated toast and we drop the streaming
      // placeholder rather than converting it to a failed bubble — these
      // aren't retryable at the message level (the user has to update or
      // wait for the outage to clear), so a Retry CTA on a per-bubble
      // failed state would be misleading.
      if (err instanceof ProtocolVersionMismatchError) {
        void showProtocolMismatchToast()
        dropStreamingPlaceholder()
      } else if (err instanceof BackendUnavailableError) {
        void toast.error(
          `${t("chat.error.backendUnavailable.title")}: ${t("chat.error.backendUnavailable.body")}`
        )
        dropStreamingPlaceholder()
      } else {
        // Unexpected error escaping the for-await loop (runChatTurn catches
        // stream-side failures internally and yields them as `error` events,
        // so we rarely land here — but if applyTurnEvent or another folded
        // step throws, surface it through the same inline path so the user
        // sees a failed bubble + Retry instead of a silently vanishing
        // placeholder.
        const code = "stream"
        const message = err instanceof Error ? err.message : "Stream failed"
        // Same session guard as the consume loop — don't synthesize a
        // failed bubble in a session the user switched to mid-stream.
        if (activeSessionId.value === sessionId) {
          applyTurnEvent({ kind: "error", code, message })
        }
      }
    } finally {
      // Deregister only our own controller — a newer turn for the same
      // session (after a detach + return) may have replaced it.
      if (turnControllers.get(sessionId) === controller) turnControllers.delete(sessionId)
      // Only the turn whose session is still on screen owns the shared
      // compose state. A detached turn finishing later must not flip
      // compose for the session the user navigated to.
      if (activeSessionId.value === sessionId) sending.value = false
      if (resumableDrop && assistantMsgId) {
        // Connection dropped but the server has the turn buffered. Keep the
        // thinking placeholder up (if this session is on screen) and recover
        // the full answer via resume — the controller is now deregistered, so
        // `resumeOnePendingTurn`'s "live stream owns it" guard lets it run.
        if (activeSessionId.value === sessionId) {
          ensureThinkingPlaceholder(sessionId, assistantMsgId)
        }
        // Prefer the persisted entry (real createdAt for TTL), but synthesize
        // one if `addPending` hasn't flushed yet — the server buffer is keyed
        // by the message id, so resume works regardless of the local record.
        const entry = (await readPending()).find(
          (p) => p.assistantMessageId === assistantMsgId
        ) ?? {
          assistantMessageId: assistantMsgId,
          sessionId,
          createdAt: Date.now(),
        }
        void resumeOnePendingTurn(entry)
      } else if (assistantMsgId) {
        // Abort path only: chatClient.ts swallows AbortError silently, so
        // no `error` event reached applyTurnEvent and the placeholder is
        // still streaming. Drop it so the spinner doesn't linger. (Real
        // errors are converted to failed-bubble by the error handler
        // above, which clears `streaming`, so this branch skips them.)
        const idx = messages.value.findIndex((m) => m.id === assistantMsgId)
        if (idx >= 0 && messages.value[idx].streaming) {
          messages.value = messages.value.filter((m) => m.id !== assistantMsgId)
        }
        // The turn is over (success, error, or abort) — drop the
        // streaming-id handle so a stray late event can't reattach to a
        // bubble that's no longer streaming.
        if (streamingMessageId === assistantMsgId) streamingMessageId = null
      }
    }
  }

  /**
   * Reflect ONE turn event from `runChatTurn` — shared by the live consume
   * loop and the resume replay so the two can't diverge.
   *
   * Applies ONLY to the session currently on screen. A turn that finishes
   * while the user is elsewhere (live switch-away OR a cold-start resume)
   * still persists its verse/cite/chapter/commentary cards via `runChatTurn`
   * → `messages.create` (keyed to that turn's own session), so reopening the
   * session loads them from SQLite — there is nothing to render off-screen.
   * Reflecting an off-screen turn here would be actively wrong: the card
   * cases write into `messages.value[streamingIndex()]`, i.e. whatever bubble
   * is streaming on the CURRENT session, so an off-screen turn's card would
   * land on the wrong message.
   */
  function reflectTurnEvent(event: RunChatTurnEvent, sessionId: string): void {
    if (activeSessionId.value === sessionId) applyTurnEvent(event)
  }

  function applyTurnEvent(event: RunChatTurnEvent): void {
    // Streaming-accumulation events (prose deltas, status/research chips, and
    // the per-message card maps) only mutate the on-screen streaming bubble —
    // delegated to `applyStreamingTurnEvent`. The lifecycle cases below touch
    // broader store state (sessions, usage, notifications) and stay here.
    if (applyStreamingTurnEvent(event, messages, streamingIndex)) return
    switch (event.kind) {
      case "user-message":
        messages.value = [...messages.value, event.message]
        return
      case "assistant-placeholder": {
        streamingMessageId = event.messageId
        // Idempotent: a thinking placeholder may already be on screen (added by
        // `ensureThinkingPlaceholder` when the session was reopened mid-turn /
        // mid-resume) — don't add a duplicate bubble.
        if (messages.value.some((m) => m.id === event.messageId)) return
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
      case "finalised": {
        // Replace the streaming placeholder with the persisted entity.
        // The turn-settled lifecycle (notification / toast / unread badge +
        // resume cleanup) is emitted from the CONSUME LOOP, not here —
        // applyTurnEvent runs only for the on-screen session, but the answer
        // must notify even when the user has navigated away.
        const idx = streamingIndex()
        streamingMessageId = null
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
        return
      }
      case "usage": {
        // Per-turn quota chip frame from the server's SSE finally-block.
        // Set the snapshot + persist under the active bucket. Persist
        // helper no-ops when qid is empty (pre-PR-1 anon tokens) — chip
        // still updates in-memory.
        chatUsage.value = {
          current: event.current,
          limit: event.limit,
          resetsAtEpoch: event.resetsAtEpoch,
        }
        const qid = useAuthStore().quotaId
        persistChatUsage(qid)
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
        // Terminal lifecycle (resume cleanup + the settle signal) is emitted
        // from the CONSUME LOOP, not here — applyTurnEvent is view-gated, but
        // a failure must still clear the pending record app-wide.
        // User-stop-with-no-content: runChatTurn emits a dedicated
        // `stopped_empty` code so we can drop the placeholder silently
        // instead of leaving a "no content" failed-bubble. There's
        // nothing useful to preserve and converting the placeholder
        // would suggest something went wrong — the user just changed
        // their mind. Stop paths with prose accumulated are persisted
        // via the `finalised` event with meta.error.kind="stopped".
        if (event.code === "stopped_empty") {
          const stoppedId = streamingMessageId
          streamingMessageId = null
          messages.value = messages.value.filter((m) => m.id !== stoppedId)
          return
        }
        // Prefer the absolute resets_at_epoch from the Phase-4 429 body
        // when present — it's authoritative server time, no clock-drift
        // pinning. Fall back to relative `Retry-After` if the server
        // hasn't rolled that out yet (or the error isn't rate_limited).
        const resetsAtMs =
          typeof event.resetsAtEpoch === "number" && event.resetsAtEpoch > 0
            ? event.resetsAtEpoch * 1000
            : undefined
        const retryAfterAt: number | undefined =
          resetsAtMs ??
          (typeof event.retryAfter === "number" && event.retryAfter > 0
            ? Date.now() + event.retryAfter * 1000
            : undefined)
        const tier = parseQuotaTier(event.tier)
        const failedErr: ChatMessageError = {
          kind: "failed",
          code: event.code,
          ...(retryAfterAt !== undefined ? { retryAfterAt } : {}),
          ...(tier !== undefined ? { tier } : {}),
        }
        // Compose-lockdown — keep the input disabled until the
        // server-side counter resets, so the user can't queue more
        // requests just to bounce them off another 429. In-memory
        // only; a cold restart drops the lockout so a server-side
        // limit change (admin reset, Redis flush, manual TTL bump)
        // is reflected on the next send attempt instead of being
        // shadowed by a stale persisted deadline. Only set for quota
        // errors; network/server errors stay retryable.
        //
        // Skip the lockout when the client already knows the user is
        // Pro and the server echoed `tier=free` — the 429 was decided
        // against a stale JWT claim (token rotation hasn't caught up
        // with a recent purchase) and arming the free-tier deadline
        // (often hours-to-midnight-UTC) would trap a paying user
        // behind a counter that doesn't apply to them. `sendMessage`
        // calls `ensureFresh` before every send, which forces a token
        // refresh on /auth/me divergence, so the next attempt goes
        // out with the corrected Pro claim and the server's quota
        // service classifies it correctly.
        const isProClaimStale = useAuthStore().isPro && event.tier === "free"
        if (event.code === "rate_limited" && retryAfterAt && !isProClaimStale) {
          composeBlockedUntil.value = retryAfterAt
          // Hydrate the usage chip from the 429 body only when the USER
          // bucket exhausted — an IP-bucket 429 means a CGNAT peer drained
          // the per-IP cap and this user's quota is fine; updating the
          // chip there would mislead. 409 (idempotency dup) and 503
          // (backend unavailable) never reach this branch — they have
          // their own codes. Note: `isProClaimStale` already excluded
          // above means we never write a free-bucket counter into a Pro
          // user's chip.
          if (
            event.keyType === "user" &&
            typeof event.current === "number" &&
            typeof event.limit === "number" &&
            event.limit > 0
          ) {
            const resetsAtEpoch =
              typeof event.resetsAtEpoch === "number" && event.resetsAtEpoch > 0
                ? event.resetsAtEpoch
                : Math.floor(retryAfterAt / 1000)
            chatUsage.value = {
              current: event.current,
              limit: event.limit,
              resetsAtEpoch,
            }
            persistChatUsage(useAuthStore().quotaId)
          }
        }
        // Transform the streaming placeholder into a failed-bubble in
        // place — keeps the message slot's id stable (handy for any
        // scroll/anchor logic) and avoids the placeholder briefly
        // vanishing before the failure appears. Failed bubbles stay
        // in-memory only: they're not useful history and the SQL
        // `parseError` whitelist would discard the `failed` kind on
        // reload anyway.
        const idx = streamingIndex()
        streamingMessageId = null
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

  /** Explicit Stop — abort the turn streaming in the ACTIVE session.
   *  Detached turns in other sessions keep running (see turnControllers). */
  function cancelStream(): void {
    const id = activeSessionId.value
    if (!id) return
    const assistantId = streamingMessageId
    const controller = turnControllers.get(id)
    if (controller) {
      controller.abort()
      turnControllers.delete(id)
    }
    // Explicit Stop ≠ passive disconnect: really cancel the turn
    // server-side and drop it from the resume queue so it isn't re-polled
    // or replayed later.
    if (assistantId) {
      void removePending(assistantId)
      void resumeService().cancelTurn(assistantId)
    }
  }

  /** Abort every in-flight turn — used by clearAll before wiping tables so
   *  no detached turn's finally persists a reply into emptied tables. */
  function cancelAllStreams(): void {
    for (const controller of turnControllers.values()) controller.abort()
    turnControllers.clear()
  }

  /** Reflect whether the active session has an in-flight (possibly
   *  detached) turn into the compose-busy flag — disables input + shows
   *  Stop. Called after every session switch since a turn may still be
   *  running in the session we just opened. */
  function syncComposeBusy(): void {
    const id = activeSessionId.value
    sending.value = id != null && turnControllers.has(id)
  }

  /* ---------------------------------------------------------------- */
  /*                      Resume in-flight turns                        */
  /* ---------------------------------------------------------------- */
  // When the app is backgrounded/killed mid-turn the live SSE stream
  // dies, but the server keeps generating and buffers the result. We
  // persist a tiny pending record per in-flight turn (survives an app
  // kill) and, on return, poll the server and replay the buffered events
  // through the SAME runChatTurn fold so the answer is rebuilt exactly —
  // never lost.

  const PENDING_TTL_MS = 24 * 60 * 60 * 1000 // mirrors the server buffer TTL

  // Preferences-backed persistence of the in-flight-turn records lives in its
  // own module; the store keeps only the resume orchestration below. Aliased
  // to the historical names so every call site reads unchanged.
  const pendingTurns = createPendingTurnStore(app.preferences)
  const readPending = pendingTurns.read
  const addPending = pendingTurns.add
  const removePending = pendingTurns.remove

  /** Replay a completed turn's buffered events into its session, rebuilding
   *  the assistant message through the `replayChatTurn` use-case (same fold
   *  as the live path). Events arrive already parsed from the resume adapter;
   *  the use-case needs no live-stream deps. */
  async function replayBufferedTurn(
    entry: PendingTurn,
    events: readonly ChatStreamEvent[]
  ): Promise<void> {
    async function* replayEvents(): AsyncIterable<ChatStreamEvent> {
      for (const ev of events) yield ev
    }
    const repos = chatRepos()
    for await (const event of replayChatTurn(
      {
        assistantMessageId: entry.assistantMessageId as ChatMessageId,
        sessionId: entry.sessionId as ChatSessionId,
        lang: chatLanguage.value || appLanguage.value,
        events: replayEvents(),
      },
      { messages: repos.messages, sessions: repos.sessions, extractFollowups }
    )) {
      reflectTurnEvent(event, entry.sessionId)
      // Surface a resumed answer the same way a live one is — notification /
      // toast / unread badge — since it arrived while the user was away. An
      // `error` settles too (ok:false) so the pre-armed forward notification is
      // cancelled instead of firing a false "answer ready".
      if (event.kind === "finalised") {
        emitTurnSettled({
          assistantMessageId: entry.assistantMessageId,
          sessionId: entry.sessionId,
          ok: true,
        })
      } else if (event.kind === "error") {
        emitTurnSettled({
          assistantMessageId: entry.assistantMessageId,
          sessionId: entry.sessionId,
          ok: false,
        })
      }
    }
  }

  /** Show a "thinking" placeholder for an in-flight turn when its session is
   *  (re)opened — so returning to a session whose answer is still generating
   *  shows the streaming indicator instead of an empty thread. Idempotent. */
  function ensureThinkingPlaceholder(sessionId: string, assistantMessageId: string): void {
    streamingMessageId = assistantMessageId as ChatMessageId
    if (messages.value.some((m) => m.id === assistantMessageId)) return
    messages.value = [
      ...messages.value,
      {
        id: assistantMessageId as ChatMessageId,
        sessionId: sessionId as ChatSessionId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        streaming: true,
      },
    ]
  }

  // Dedup guard so overlapping resume triggers don't stack poll loops per turn.
  const resumePolling = new Set<string>()

  async function resumeOnePendingTurn(entry: PendingTurn): Promise<void> {
    if (resumePolling.has(entry.assistantMessageId)) return
    resumePolling.add(entry.assistantMessageId)
    try {
      // Poll until the turn is done/error (or ~2.5 min). While `running`, keep
      // the thinking indicator up if its session is on screen.
      for (let i = 0; i < 60; i++) {
        // A live stream owns this session's turn — don't double-drive it.
        if (turnControllers.has(entry.sessionId)) return
        let buffered
        try {
          buffered = await resumeService().getTurn(entry.assistantMessageId)
        } catch {
          return // transient (offline / token refresh) — retry next resume
        }
        if (buffered === null) {
          // Never received, expired, or not ours. Drop only once older than the
          // server TTL so a momentary 404 race doesn't lose a turn — and settle
          // it (ok:false) so the pre-armed forward notification is cancelled
          // rather than firing a false "answer ready".
          if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
            emitTurnSettled({
              assistantMessageId: entry.assistantMessageId,
              sessionId: entry.sessionId,
              ok: false,
            })
            await removePending(entry.assistantMessageId)
          }
          return
        }
        if (buffered.state === "running") {
          // A turn stuck `running` server-side forever would otherwise strand
          // the pending record AND its thinking placeholder past the buffer
          // TTL (the poll loop only runs ~2.5 min per resume, but re-arms on
          // every app resume). Give up once older than the TTL: settle ok:false
          // (cancels the pre-armed forward notification) and clear the record +
          // this entry's lingering placeholder.
          if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
            emitTurnSettled({
              assistantMessageId: entry.assistantMessageId,
              sessionId: entry.sessionId,
              ok: false,
            })
            if (activeSessionId.value === entry.sessionId) {
              messages.value = messages.value.filter((m) => m.id !== entry.assistantMessageId)
            }
            await removePending(entry.assistantMessageId)
            return
          }
          if (activeSessionId.value === entry.sessionId) {
            ensureThinkingPlaceholder(entry.sessionId, entry.assistantMessageId)
          }
          await new Promise((resolve) => setTimeout(resolve, 2500))
          continue
        }
        // done | error. If the live turn already persisted this assistant
        // message (app killed AFTER finalise, before pending was cleared) the
        // answer is on disk — re-running the replay would INSERT a duplicate id
        // (PK) and throw. Skip the replay then; just clear pending. The finally
        // guarantees no entry is ever stranded in a re-throw loop.
        try {
          const rows = await chatRepos().messages.listBySession(entry.sessionId as ChatSessionId)
          const existing = rows.find((m) => m.id === entry.assistantMessageId)
          if (existing?.error) {
            // A truncated/failed live stub left by a dropped connection — drop
            // it from disk AND the in-memory view so the buffered FULL answer
            // replaces it cleanly (re-running the replay otherwise hits the
            // PK on insert).
            await chatRepos().messages.delete(entry.assistantMessageId as ChatMessageId)
            messages.value = messages.value.filter((m) => m.id !== entry.assistantMessageId)
          }
          // Replay unless a CLEAN answer is already on disk (app killed after
          // finalise but before pending was cleared — replaying would dupe).
          if (!existing || existing.error) {
            await replayBufferedTurn(entry, buffered.events)
          } else {
            // Clean answer already persisted — no replay needed, but still
            // settle the turn (ok:true) so the pre-armed forward notification
            // is cancelled instead of firing a false "answer ready" for an
            // answer already on disk. replayBufferedTurn would have settled;
            // this skip path must too.
            emitTurnSettled({
              assistantMessageId: entry.assistantMessageId,
              sessionId: entry.sessionId,
              ok: true,
            })
          }
        } catch (err) {
          console.error("[chat] resume replay failed", err)
        } finally {
          await removePending(entry.assistantMessageId)
        }
        return
      }
    } finally {
      resumePolling.delete(entry.assistantMessageId)
    }
  }

  /** On app resume / cold start: poll + replay any turn whose live stream
   *  was dropped. Skips turns still streaming live in this session. */
  async function resumePendingTurns(): Promise<void> {
    const list = await readPending()
    for (const entry of list) {
      if (turnControllers.has(entry.sessionId)) continue
      void resumeOnePendingTurn(entry)
    }
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

  /** Set of `<messageId>\0<actionId>` keys whose `executeAction` is
   *  mid-flight. The guard below flips this SYNCHRONOUSLY (before any
   *  await) so a second confirm tap that arrives before
   *  `setActionState("executing")` has persisted is still rejected —
   *  otherwise both taps pass the state check and the side effect
   *  (playlist.add / reminder / paywall) runs twice. */
  const inFlightActions = new Set<string>()

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

    // Synchronous double-tap guard: the persisted "executing" flip below
    // awaits a SQLite write, leaving a window in which a second rapid tap
    // would also pass `currentState`. Claim the slot here, before any
    // await, and release it in `finally`.
    const lockKey = `${messageId}\0${actionId}`
    if (inFlightActions.has(lockKey)) return
    inFlightActions.add(lockKey)

    await setActionState(messageId, actionId, "executing")
    try {
      if (action.kind === "enable_daily_reminder") {
        // Card lets the user pick a time before tapping Confirm; if
        // they did, the chosen value rides in via `override.time`.
        await applyProactiveDailyReminder(override?.time ?? action.time)
      } else if (action.kind === "configure_smart_library") {
        await applyProactiveSmartLibrary(action.filters)
      } else if (action.kind === "upgrade_to_pro") {
        const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
        usePaywallStore().requestOpen()
      } else if (action.kind === "queue_next_track") {
        const r = await playlist.add(action.trackId as TrackId)
        if (!r.ok && r.error !== "already-in-playlist") {
          throw new Error(`queue next failed: ${r.error}`)
        }
      } else if (action.kind === "add_to_library") {
        await applyAddToLibrary(action)
      }
      await setActionState(messageId, actionId, "done")
    } catch (err) {
      console.warn("chat: action execution failed", err)
      await setActionState(messageId, actionId, "error")
    } finally {
      inFlightActions.delete(lockKey)
    }
  }

  async function recordInlineHintCooldown(
    chatMessageId: string,
    payload: ChatActionPayload
  ): Promise<void> {
    try {
      await recordInlineHintCooldownUC(
        {
          chatMessageId: chatMessageId as ChatMessageId,
          payload,
          now: new Date(),
        },
        { proactiveState: app.repositories().proactiveState }
      )
    } catch (err) {
      // Best-effort — if attach fails the user still sees the inline
      // card, just the autonomous tutorial may double up next month.
      console.debug("[proactive] inline hint attach failed:", err)
    }
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
      usePaywallStore().requestOpen("smartLibrary")
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

  /**
   * Confirm an `add_to_library` candidate card (personal library, epic #1236):
   * PRO-gate, then trigger ingest of the external lecture. Mirrors
   * `applyProactiveSmartLibrary` — adding external lectures is a Pro capability,
   * so a non-subscriber is bounced through the paywall and nothing is ingested.
   *
   * The client→server call reuses the deployed add-to-library chat transport:
   * we hand the candidate URL back as a turn so the server's add-to-library
   * intent publishes the `ingest.request` (the only client→server path that
   * reaches the ingest broker). We then fire `requestSync()` so the poller drops
   * into its short cadence and surfaces the freshly-queued item (and its
   * processing → ready flip) without waiting out the idle interval.
   */
  async function applyAddToLibrary(
    action: Extract<ChatActionPayload, { kind: "add_to_library" }>
  ): Promise<void> {
    await sendAddToLibrary(action.url)
  }

  /**
   * PRO-gate, then trigger ingest of an external lecture by URL through the
   * deployed add-to-library chat transport (see {@link applyAddToLibrary}).
   * Shared by the candidate-card confirm and the failed-library-item retry: a
   * re-add of a dead-lettered source maps to the same orchestrator job, which
   * restarts it in place. A non-subscriber is bounced through the paywall and
   * nothing is sent.
   */
  async function sendAddToLibrary(url: string): Promise<void> {
    const { usePurchasesStore } = await import("@shruti/stores/usePurchasesStore.js")
    if (!usePurchasesStore().isSubscribed) {
      const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
      usePaywallStore().requestOpen()
      return
    }
    // Send a readable command (not a bare URL) so the chat turn looks
    // intentional; it still routes to add-to-library (the URL is present) and
    // the worker resolves the title/metadata from it server-side.
    await sendMessage(t("chat.addByLinkCommand", { url }))
    requestSync()
  }

  async function deleteSession(id: string): Promise<void> {
    const repos = chatRepos()
    // One transaction so a failure can't delete the messages but leave the
    // session row behind as a "zombie" empty conversation in history.
    await app.repositories().unitOfWork.run(async () => {
      await repos.messages.deleteBySession(id as ChatSessionId)
      await repos.sessions.delete(id as ChatSessionId)
    })
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeSessionId.value === id) {
      activeSessionId.value = null
      messages.value = []
    }
  }

  async function clearAll(): Promise<void> {
    // Stop ALL in-flight SSE streams first — otherwise a streaming
    // finally-block would persist its accumulated reply into the
    // freshly-emptied tables, leaving an orphan row.
    cancelAllStreams()
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

  /**
   * Persist a thumbs-up/down (with optional category + comment) for an
   * assistant message and ship it to the backend. Throws on POST
   * failure — the UI catches and toasts; local state is only mutated
   * on success so a network blip doesn't desync the bubble from the
   * server.
   *
   * State-machine notes:
   *   - flipping up ↔ down upserts the `user_feedback` score on the
   *     trace via deterministic score_id (server side);
   *   - category/comment scores are written ONLY when value=down. When
   *     a user later flips down→up, those orphan rows stay (Langfuse
   *     SDK has no delete). The bubble's `feedbackCategory` /
   *     `feedbackComment` are dropped on `up` so the UI is consistent
   *     locally.
   */
  async function submitFeedback(
    messageId: ChatMessageId,
    feedback: {
      state: "up" | "down"
      category?: FeedbackCategory
      comment?: string
    }
  ): Promise<void> {
    const msg = messages.value.find((m) => m.id === messageId)
    if (!msg || msg.role !== "assistant") {
      throw new Error("submitFeedback: assistant message not found")
    }

    const repos = chatRepos()
    const port = feedbackService()
    await submitChatFeedback(
      {
        messageId,
        state: feedback.state,
        category: feedback.category,
        comment: feedback.comment,
      },
      {
        messages: repos.messages,
        post: (payload) => port.submitFeedback(payload),
      }
    )

    // Reflect on the in-memory message so the bubble re-renders with
    // the selected thumb without needing a full session reload.
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx >= 0) {
      const next = [...messages.value]
      const cur = next[idx]
      next[idx] = {
        ...cur,
        feedbackState: feedback.state,
        feedbackCategory: feedback.state === "down" ? feedback.category : undefined,
        feedbackComment: feedback.state === "down" ? feedback.comment : undefined,
      }
      messages.value = next
    }
  }

  // Native app-lifecycle wiring (cold start + appStateChange resume) lives
  // in the `useChatResume` composable, mounted by App.vue — the store
  // exposes `resumePendingTurns` and stays free of Capacitor.
  return {
    sessions,
    activeSession,
    activeSessionId,
    messages,
    sending,
    resumePendingTurns,
    listPendingTurns: readPending,
    sessionTitleFor,
    markAnswerUnread,
    getLastSeenMessageId,
    markSessionSeen,
    loadingFocusIds,
    inputFocusToken,
    composeBlockedUntil,
    isComposeBlocked,
    resetComposeLock,
    chatUsage,
    unseenProactiveSessionIds,
    refreshSessions,
    openSession,
    openOrCreateFocusedSession,
    appendFocusMessage,
    requestSuggestions,
    requestInputFocus,
    startNewSession,
    ensureActiveSession,
    sendMessage,
    sendAddToLibrary,
    cancelStream,
    retryLast,
    executeAction,
    deleteSession,
    clearAll,
    searchSessions,
    submitFeedback,
  }
})

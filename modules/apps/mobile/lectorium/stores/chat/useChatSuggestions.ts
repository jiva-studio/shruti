import { ref, type Ref } from "vue"
import type { ChatFocusPayload } from "@lib/domain"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/index.js"
import type { ChatMessage } from "./chatTypes.js"

export interface ChatQuestionsService {
  fetchSuggestedQuestions: (
    focus: Omit<ChatFocusPayload, "text"> & { text: string },
    lang: string,
    opts: { signal: AbortSignal }
  ) => Promise<readonly string[]>
}

export interface ChatSuggestionsDeps {
  messages: Ref<ChatMessage[]>
  activeSessionId: Ref<string | null>
  chatMessages: () => IChatMessageRepository
  questionsService: () => ChatQuestionsService
  lang: () => string
}

export interface ChatSuggestions {
  /** Focus message ids whose `/questions` round-trip is in flight. */
  loadingFocusIds: Ref<ReadonlySet<string>>
  inputFocusToken: Ref<number>
  requestSuggestions: (messageId: ChatMessageId, focus: ChatFocusPayload) => Promise<void>
  cancelSuggestions: () => void
  requestInputFocus: () => void
}

/**
 * The follow-up chips under a focus card. The texts ride on the message's
 * `followups` field, so they survive a session reload; an empty array means
 * "the fetch resolved with nothing", which the card renders as its static
 * list.
 */
export function useChatSuggestions(deps: ChatSuggestionsDeps): ChatSuggestions {
  const { messages, activeSessionId } = deps

  const loadingFocusIds = ref<ReadonlySet<string>>(new Set())
  // Bumped after a focus message is appended and navigation is queued;
  // ChatView watches it and focuses the textarea once the router lands.
  const inputFocusToken = ref<number>(0)

  let suggestionsAbort: AbortController | null = null

  /** Fire-and-forget; aborts itself if the active session changes mid-flight. */
  async function requestSuggestions(
    messageId: ChatMessageId,
    focus: ChatFocusPayload
  ): Promise<void> {
    cancelSuggestions()
    const ctl = new AbortController()
    suggestionsAbort = ctl
    const forSessionId = activeSessionId.value
    markLoading(messageId, true)
    try {
      const result = await deps.questionsService().fetchSuggestedQuestions(
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
        deps.lang(),
        { signal: ctl.signal }
      )
      if (ctl.signal.aborted || activeSessionId.value !== forSessionId) return
      await applyFollowups(messageId, result.length > 0 ? [...result] : [])
    } catch {
      // The service maps errors to []; this catch is defence in depth.
    } finally {
      if (suggestionsAbort === ctl) suggestionsAbort = null
      markLoading(messageId, false)
    }
  }

  async function applyFollowups(
    messageId: ChatMessageId,
    followups: readonly string[]
  ): Promise<void> {
    try {
      await deps.chatMessages().updateFollowups(messageId, followups)
    } catch (err) {
      console.warn("chat: failed to persist focus followups", err)
    }
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const next = [...messages.value]
    next[idx] = { ...next[idx], followups }
    messages.value = next
  }

  function markLoading(messageId: string, loading: boolean): void {
    const next = new Set(loadingFocusIds.value)
    if (loading) next.add(messageId)
    else next.delete(messageId)
    loadingFocusIds.value = next
  }

  function cancelSuggestions(): void {
    if (suggestionsAbort) {
      suggestionsAbort.abort()
      suggestionsAbort = null
    }
    if (loadingFocusIds.value.size > 0) loadingFocusIds.value = new Set()
  }

  /** Idempotent — ChatView focuses the textarea on every increment. */
  function requestInputFocus(): void {
    inputFocusToken.value = (inputFocusToken.value + 1) % 1_000_000
  }

  return {
    loadingFocusIds,
    inputFocusToken,
    requestSuggestions,
    cancelSuggestions,
    requestInputFocus,
  }
}

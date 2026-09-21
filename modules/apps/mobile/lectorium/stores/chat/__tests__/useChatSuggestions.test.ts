import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { ChatFocusPayload } from "@lib/domain"
import type { ChatMessageId, TrackId } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/index.js"
import type { ChatMessage } from "../chatTypes.js"
import { useChatSuggestions } from "../useChatSuggestions.js"

const MSG = "m-1" as ChatMessageId

const FOCUS: ChatFocusPayload = {
  trackId: "t-1" as TrackId,
  startMs: 1000,
  endMs: 5000,
  text: "the soul is eternal",
  sourceKey: "audio/t-1.mp3",
  trackTitle: "Lecture 1",
  authorName: "Author",
  date: "1972-08-14",
  location: "Bombay",
}

function message(id: string): ChatMessage {
  return { id: id as ChatMessageId, followups: undefined } as unknown as ChatMessage
}

function harness(fetchImpl: ChatFetch = async () => ["a", "b"]) {
  const messages = ref<ChatMessage[]>([message("m-1"), message("m-2")])
  const activeSessionId = ref<string | null>("s-1")
  const updateFollowups = vi.fn(async () => {})
  const fetchSuggestedQuestions = vi.fn(fetchImpl)
  const suggestions = useChatSuggestions({
    messages,
    activeSessionId,
    chatMessages: () => ({ updateFollowups }) as unknown as IChatMessageRepository,
    questionsService: () => ({ fetchSuggestedQuestions }),
    lang: () => "en",
  })
  return { suggestions, messages, activeSessionId, updateFollowups, fetchSuggestedQuestions }
}

type ChatFetch = (
  focus: Omit<ChatFocusPayload, "text"> & { text: string },
  lang: string,
  opts: { signal: AbortSignal }
) => Promise<readonly string[]>

describe("useChatSuggestions", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("writes the fetched chips onto the message and clears the loading flag", async () => {
    const h = harness()

    const pending = h.suggestions.requestSuggestions(MSG, FOCUS)
    expect(h.suggestions.loadingFocusIds.value.has(MSG)).toBe(true)
    await pending

    expect(h.messages.value[0].followups).toEqual(["a", "b"])
    expect(h.messages.value[1].followups).toBeUndefined()
    expect(h.suggestions.loadingFocusIds.value.size).toBe(0)
    expect(h.updateFollowups).toHaveBeenCalledWith(MSG, ["a", "b"])
  })

  it("passes the focus fields and language through to the questions service", async () => {
    const h = harness()

    await h.suggestions.requestSuggestions(MSG, FOCUS)

    const [sent, lang] = h.fetchSuggestedQuestions.mock.calls[0]
    expect(sent).toEqual({
      trackId: FOCUS.trackId,
      startMs: 1000,
      endMs: 5000,
      text: "the soul is eternal",
      sourceKey: "audio/t-1.mp3",
      trackTitle: "Lecture 1",
      authorName: "Author",
      date: "1972-08-14",
      location: "Bombay",
    })
    expect(lang).toBe("en")
  })

  it("records an empty result as an empty list, not as absent", async () => {
    const h = harness(async () => [])

    await h.suggestions.requestSuggestions(MSG, FOCUS)

    expect(h.messages.value[0].followups).toEqual([])
  })

  it("still applies the chips in memory when persisting them fails", async () => {
    const h = harness()
    h.updateFollowups.mockRejectedValue(new Error("db locked"))

    await h.suggestions.requestSuggestions(MSG, FOCUS)

    expect(h.messages.value[0].followups).toEqual(["a", "b"])
  })

  it("swallows a service rejection and still clears the loading flag", async () => {
    const h = harness(async () => {
      throw new Error("offline")
    })

    await expect(h.suggestions.requestSuggestions(MSG, FOCUS)).resolves.toBeUndefined()

    expect(h.messages.value[0].followups).toBeUndefined()
    expect(h.suggestions.loadingFocusIds.value.size).toBe(0)
  })

  it("drops a result that lands after the user switched sessions", async () => {
    let release: (v: readonly string[]) => void = () => {}
    const h = harness(() => new Promise((r) => (release = r)))

    const pending = h.suggestions.requestSuggestions(MSG, FOCUS)
    h.activeSessionId.value = "s-2"
    release(["stale"])
    await pending

    expect(h.messages.value[0].followups).toBeUndefined()
    expect(h.updateFollowups).not.toHaveBeenCalled()
  })

  it("aborts the in-flight request when a second one starts", async () => {
    const signals: AbortSignal[] = []
    const h = harness((_f, _l, { signal }) => {
      signals.push(signal)
      return new Promise(() => {})
    })

    void h.suggestions.requestSuggestions(MSG, FOCUS)
    void h.suggestions.requestSuggestions("m-2" as ChatMessageId, FOCUS)

    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })

  it("discards a result that resolves after the request was cancelled", async () => {
    let release: (v: readonly string[]) => void = () => {}
    const h = harness(() => new Promise((r) => (release = r)))

    const pending = h.suggestions.requestSuggestions(MSG, FOCUS)
    h.suggestions.cancelSuggestions()
    release(["stale"])
    await pending

    expect(h.messages.value[0].followups).toBeUndefined()
    expect(h.suggestions.loadingFocusIds.value.size).toBe(0)
  })

  it("cancelSuggestions on an idle tracker leaves the loading set alone", () => {
    const h = harness()

    h.suggestions.cancelSuggestions()

    expect(h.suggestions.loadingFocusIds.value.size).toBe(0)
  })

  it("ignores a result whose message is no longer in the list", async () => {
    const h = harness()

    await h.suggestions.requestSuggestions("gone" as ChatMessageId, FOCUS)

    expect(h.messages.value.map((m) => m.followups)).toEqual([undefined, undefined])
  })

  it("bumps the input-focus token on every request", () => {
    const h = harness()
    const start = h.suggestions.inputFocusToken.value

    h.suggestions.requestInputFocus()
    h.suggestions.requestInputFocus()

    expect(h.suggestions.inputFocusToken.value).toBe(start + 2)
  })

  it("wraps the input-focus token rather than growing without bound", () => {
    const h = harness()
    h.suggestions.inputFocusToken.value = 999_999

    h.suggestions.requestInputFocus()

    expect(h.suggestions.inputFocusToken.value).toBe(0)
  })
})

import { describe, expect, it } from "vitest"
import { ref, type Ref } from "vue"
import type { RunChatTurnEvent } from "@usecases"
import { applyStreamingTurnEvent } from "../chatTurnReducer.js"
import type { ChatMessage } from "../useChatStore.js"

/** A one-message list with a streaming bubble at index 0. */
function streamingList(extra: Partial<ChatMessage> = {}): Ref<ChatMessage[]> {
  return ref<ChatMessage[]>([
    {
      id: "a1",
      sessionId: "s1",
      role: "assistant",
      content: "",
      createdAt: 0,
      streaming: true,
      ...extra,
    } as ChatMessage,
  ])
}
const atZero = (msgs: Ref<ChatMessage[]>) => () => (msgs.value.length > 0 ? 0 : -1)

describe("applyStreamingTurnEvent", () => {
  it("appends delta text to the streaming bubble", () => {
    const msgs = streamingList({ content: "He" })
    const handled = applyStreamingTurnEvent(
      { kind: "delta", text: "llo" } as RunChatTurnEvent,
      msgs,
      atZero(msgs)
    )
    expect(handled).toBe(true)
    expect(msgs.value[0].content).toBe("Hello")
  })

  it("stashes a verse payload under `<sourceId>|<tokens>`", () => {
    const msgs = streamingList()
    applyStreamingTurnEvent(
      {
        kind: "verse-payload",
        sourceId: "bg",
        tokens: "2.13",
        addrLabel: "BG 2.13",
        sanskrit: "x",
        transliteration: "x",
        translation: { en: "e" },
      } as RunChatTurnEvent,
      msgs,
      atZero(msgs)
    )
    expect(msgs.value[0].verses?.["bg|2.13"]).toMatchObject({ addrLabel: "BG 2.13" })
  })

  it("stashes a media payload under its id", () => {
    const msgs = streamingList()
    applyStreamingTurnEvent(
      {
        kind: "media-payload",
        payload: { id: "vid1", url: "u", type: "video", title: "t", text: "" },
      } as RunChatTurnEvent,
      msgs,
      atZero(msgs)
    )
    expect(msgs.value[0].media?.["vid1"]).toMatchObject({ id: "vid1", type: "video" })
  })

  it("tool-start clears prose AND every card map", () => {
    const msgs = streamingList({
      content: "abandoned",
      verses: { "bg|2.13": {} as never },
      media: { vid1: {} as never },
    })
    applyStreamingTurnEvent({ kind: "tool-start" } as RunChatTurnEvent, msgs, atZero(msgs))
    expect(msgs.value[0].content).toBe("")
    expect(msgs.value[0].verses).toBeUndefined()
    expect(msgs.value[0].media).toBeUndefined()
  })

  it("returns false for a lifecycle event so the store handles it", () => {
    const msgs = streamingList()
    const handled = applyStreamingTurnEvent(
      { kind: "finalised", message: {} as ChatMessage } as RunChatTurnEvent,
      msgs,
      atZero(msgs)
    )
    expect(handled).toBe(false)
  })

  it("is a no-op (but still handled) when no bubble is streaming", () => {
    const msgs = ref<ChatMessage[]>([])
    const handled = applyStreamingTurnEvent(
      { kind: "delta", text: "x" } as RunChatTurnEvent,
      msgs,
      () => -1
    )
    expect(handled).toBe(true)
    expect(msgs.value).toHaveLength(0)
  })
})

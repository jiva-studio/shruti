import { describe, it, expect } from "vitest"
import { toHistoryTurns } from "../chatHistory.js"
import type { ChatMessage } from "../chatTypes.js"

function message(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "user",
    content: "hello",
    createdAt: 0,
    ...over,
  } as ChatMessage
}

describe("toHistoryTurns", () => {
  it("drops the streaming placeholder", () => {
    const turns = toHistoryTurns([
      message({ id: "m1", content: "q" }),
      message({ id: "m2", role: "assistant", content: "", streaming: true }),
    ])

    expect(turns).toEqual([{ role: "user", content: "q" }])
  })

  it("carries aliases and attributes back on assistant turns", () => {
    const turns = toHistoryTurns([
      message({
        id: "m2",
        role: "assistant",
        content: "a",
        aliases: { 1: "chunk-1" },
        attributes: { lang: "ru" },
      } as unknown as Partial<ChatMessage>),
    ])

    expect(turns).toEqual([
      { role: "assistant", content: "a", aliases: { 1: "chunk-1" }, attributes: { lang: "ru" } },
    ])
  })

  it("omits an empty alias map and leaves user turns bare", () => {
    const turns = toHistoryTurns([
      message({ id: "m1", content: "q", aliases: {} } as Partial<ChatMessage>),
      message({ id: "m2", role: "assistant", content: "a", aliases: {} } as Partial<ChatMessage>),
    ])

    expect(turns).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ])
  })
})

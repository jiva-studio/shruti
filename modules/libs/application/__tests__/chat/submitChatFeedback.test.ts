import { describe, expect, it, vi } from "vitest"
import { submitChatFeedback } from "../../chat/submitChatFeedback.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { ChatMessageId } from "@lib/domain/core.js"

function makeRepo(over: Partial<IChatMessageRepository> = {}): IChatMessageRepository {
  return {
    listBySession: async () => [],
    create: async () => {
      throw new Error("create not stubbed")
    },
    updateActionStates: async () => {},
    delete: async () => {},
    updateFollowups: async () => {},
    deleteBySession: async () => {},
    clearAll: async () => {},
    updateFeedback: async () => {},
    ...over,
  } as IChatMessageRepository
}

describe("submitChatFeedback", () => {
  it("posts first, then persists locally — both with the same shape", async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const updateFeedback = vi.fn().mockResolvedValue(undefined)
    const repo = makeRepo({ updateFeedback })
    await submitChatFeedback(
      { messageId: "m1" as ChatMessageId, state: "down", category: "off_topic", comment: "bad" },
      { messages: repo, post }
    )
    expect(post).toHaveBeenCalledWith({
      messageId: "m1",
      value: "down",
      category: "off_topic",
      comment: "bad",
    })
    expect(updateFeedback).toHaveBeenCalledWith("m1", {
      state: "down",
      category: "off_topic",
      comment: "bad",
    })
    // ordering: post must come first
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(
      updateFeedback.mock.invocationCallOrder[0]
    )
  })

  it("drops category and comment when state === 'up'", async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const updateFeedback = vi.fn().mockResolvedValue(undefined)
    const repo = makeRepo({ updateFeedback })
    await submitChatFeedback(
      { messageId: "m1" as ChatMessageId, state: "up", category: "off_topic", comment: "ignored" },
      { messages: repo, post }
    )
    expect(post).toHaveBeenCalledWith({
      messageId: "m1",
      value: "up",
      category: undefined,
      comment: undefined,
    })
    expect(updateFeedback).toHaveBeenCalledWith("m1", {
      state: "up",
      category: undefined,
      comment: undefined,
    })
  })

  it("does not persist locally when the remote post throws", async () => {
    const post = vi.fn().mockRejectedValue(new Error("503"))
    const updateFeedback = vi.fn().mockResolvedValue(undefined)
    const repo = makeRepo({ updateFeedback })
    await expect(
      submitChatFeedback(
        { messageId: "m1" as ChatMessageId, state: "up" },
        { messages: repo, post }
      )
    ).rejects.toThrow(/503/)
    expect(updateFeedback).not.toHaveBeenCalled()
  })
})

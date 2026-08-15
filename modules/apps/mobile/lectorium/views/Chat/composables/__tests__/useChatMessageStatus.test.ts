import { beforeEach, describe, expect, it, vi } from "vitest"
import { reactive } from "vue"
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"

const chat = reactive({ sending: false, isComposeBlocked: false })
vi.mock("@lectorium/stores/useChatStore.js", () => ({
  useChatStore: () => chat,
}))

import { useChatMessageStatus } from "../useChatMessageStatus.js"

function truncated(): ChatMessage {
  return {
    id: "a1" as ChatMessageId,
    sessionId: "s1" as ChatSessionId,
    role: "assistant",
    content: "The soul is",
    createdAt: 2,
    error: { kind: "truncated", reason: "stream" } as ChatMessage["error"],
  }
}

beforeEach(() => {
  chat.sending = false
  chat.isComposeBlocked = false
})

describe("useChatMessageStatus.canRetry — the armed quota lock (issue #1837)", () => {
  it("enables Retry on the last failed bubble while the store is idle", () => {
    const s = useChatMessageStatus({
      message: truncated,
      isLast: () => true,
      onRequestRetry: vi.fn(),
    })
    expect(s.canRetry.value).toBe(true)
  })

  it("disables it while the composer is quota-locked", () => {
    chat.isComposeBlocked = true
    const onRequestRetry = vi.fn()
    const s = useChatMessageStatus({ message: truncated, isLast: () => true, onRequestRetry })

    // `retryLast` deletes the pair before re-sending, and a locked
    // `sendMessage` starts nothing — so the control must read as unavailable
    // rather than look live and silently destroy the turn.
    expect(s.canRetry.value).toBe(false)
    s.onRetry()
    expect(onRequestRetry).not.toHaveBeenCalled()
  })

  it("keeps the truncated actions row visible so the disabled control is seen", () => {
    chat.isComposeBlocked = true
    const s = useChatMessageStatus({
      message: truncated,
      isLast: () => true,
      onRequestRetry: vi.fn(),
    })
    expect(s.truncatedRetryVisible.value).toBe(true)
  })
})

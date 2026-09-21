import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref, type Ref } from "vue"
import type { RunChatTurnEvent } from "@usecases"
import type { ChatActionPayload } from "@lib/domain"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ChatUsageChip } from "../useChatUsageChip.js"
import { BARE_RATE_LIMIT_LOCKOUT_MS, type ChatComposeLock } from "../useChatComposeLock.js"
import type { ChatMessage, ChatSession } from "../chatTypes.js"
import type { StreamTarget } from "../chatBubbles.js"
import { createChatTurnFold, type ChatTurnFoldDeps } from "../useChatTurnFold.js"

const NOW = Date.parse("2026-05-17T16:42:00Z")
const SESSION = "s-1" as ChatSessionId

function message(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: SESSION,
    role: "assistant",
    content: "",
    createdAt: NOW,
    ...over,
  }
}

interface Harness {
  readonly deps: ChatTurnFoldDeps
  readonly messages: Ref<ChatMessage[]>
  readonly sessions: Ref<ChatSession[]>
  readonly activeSessionId: Ref<string | null>
  readonly target: StreamTarget
  readonly rateLimits: { retryAfterAt: number; tier?: string }[]
  readonly usages: { current: number; limit: number }[]
  readonly cooldowns: { messageId: string; payload: ChatActionPayload }[]
  retryReplacing: ReadonlySet<string> | null
}

function harness(initial: ChatMessage[] = []): Harness {
  const messages = ref<ChatMessage[]>(initial)
  const sessions = ref<ChatSession[]>([
    { id: SESSION, title: "Old title", createdAt: NOW, updatedAt: NOW },
  ])
  const activeSessionId = ref<string | null>(SESSION)
  const target: StreamTarget = { messageId: null }
  const rateLimits: Harness["rateLimits"] = []
  const usages: Harness["usages"] = []
  const cooldowns: Harness["cooldowns"] = []

  const h: Harness = {
    messages,
    sessions,
    activeSessionId,
    target,
    rateLimits,
    usages,
    cooldowns,
    retryReplacing: null,
    deps: {
      messages,
      sessions,
      activeSessionId,
      usage: {
        snapshot: ref(null),
        hydrate: async () => undefined,
        record: (u) => usages.push({ current: u.current, limit: u.limit }),
        recordFromRateLimit: () => undefined,
      } satisfies ChatUsageChip,
      composeLock: {
        composeBlockedUntil: ref<number | null>(null),
        isComposeBlocked: computed(() => false),
        applyRateLimit: (info) => rateLimits.push({ ...info }),
        resetComposeLock: () => undefined,
      } satisfies ChatComposeLock,
      takeRetryReplacing: () => h.retryReplacing,
      recordInlineHintCooldown: async (messageId, payload) => {
        cooldowns.push({ messageId, payload })
      },
    },
  }
  return h
}

function errorEvent(
  over: Partial<Extract<RunChatTurnEvent, { kind: "error" }>> = {}
): RunChatTurnEvent {
  return { kind: "error", code: "server_error", message: "boom", ...over }
}

describe("createChatTurnFold — session gating", () => {
  it("applies a turn belonging to the session on screen", () => {
    const h = harness()
    const fold = createChatTurnFold(h.deps)

    fold.reflectTurnEvent({ kind: "title-updated", title: "New title" }, SESSION, h.target)

    expect(h.sessions.value[0].title).toBe("New title")
  })

  it("ignores a turn that finished while the user was elsewhere", () => {
    const h = harness()
    const fold = createChatTurnFold(h.deps)

    fold.reflectTurnEvent({ kind: "title-updated", title: "New title" }, "other", h.target)

    expect(h.sessions.value[0].title).toBe("Old title")
  })
})

describe("createChatTurnFold — user message", () => {
  it("appends the prompt", () => {
    const h = harness([message("a-0")])
    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "user-message", message: message("u-1", { role: "user", content: "why?" }) },
      h.target
    )

    expect(h.messages.value.map((m) => m.id)).toEqual(["a-0", "u-1"])
  })

  it("swaps out the retried pair in the same write that brings the prompt in", () => {
    const h = harness([message("u-0", { role: "user" }), message("a-0")])
    h.retryReplacing = new Set(["u-0", "a-0"])

    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "user-message", message: message("u-1", { role: "user" }) },
      h.target
    )

    expect(h.messages.value.map((m) => m.id)).toEqual(["u-1"])
  })
})

describe("createChatTurnFold — placeholder", () => {
  it("claims the bubble and draws it", () => {
    const h = harness()
    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "assistant-placeholder", messageId: "a-1" as ChatMessageId },
      h.target
    )

    expect(h.target.messageId).toBe("a-1")
    expect(h.messages.value).toHaveLength(1)
    expect(h.messages.value[0].streaming).toBe(true)
  })

  it("claims a bubble that a reopened session already drew, without duplicating it", () => {
    const h = harness([message("a-1", { streaming: true })])
    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "assistant-placeholder", messageId: "a-1" as ChatMessageId },
      h.target
    )

    expect(h.messages.value).toHaveLength(1)
    expect(h.target.messageId).toBe("a-1")
  })
})

describe("createChatTurnFold — finalised", () => {
  it("replaces the streaming bubble in place and releases the target", () => {
    const h = harness([message("a-1", { streaming: true, content: "partial" })])
    h.target.messageId = "a-1" as ChatMessageId

    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "finalised", message: message("a-1", { content: "the answer" }) },
      h.target
    )

    expect(h.messages.value).toHaveLength(1)
    expect(h.messages.value[0].content).toBe("the answer")
    expect(h.messages.value[0].streaming).toBeUndefined()
    expect(h.target.messageId).toBeNull()
  })

  it("appends the answer when no bubble was claimed", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "finalised", message: message("a-1", { content: "the answer" }) },
      h.target
    )

    expect(h.messages.value.map((m) => m.id)).toEqual(["a-1"])
  })

  it("records a cooldown per action card the answer carries", () => {
    const h = harness()
    const action: ChatActionPayload = { kind: "enable_daily_reminder", id: "main", time: "08:00" }

    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "finalised", message: message("a-1", { actions: { main: action } }) },
      h.target
    )

    expect(h.cooldowns).toEqual([{ messageId: "a-1", payload: action }])
  })

  it("records nothing for an answer with no action cards", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "finalised", message: message("a-1") },
      h.target
    )

    expect(h.cooldowns).toEqual([])
  })
})

describe("createChatTurnFold — title and usage", () => {
  it("leaves the list alone when the titled session is no longer listed", () => {
    const h = harness()
    h.activeSessionId.value = "gone"

    createChatTurnFold(h.deps).applyTurnEvent({ kind: "title-updated", title: "New" }, h.target)

    expect(h.sessions.value[0].title).toBe("Old title")
  })

  it("leaves the list alone when no session is open", () => {
    const h = harness()
    h.activeSessionId.value = null

    createChatTurnFold(h.deps).applyTurnEvent({ kind: "title-updated", title: "New" }, h.target)

    expect(h.sessions.value[0].title).toBe("Old title")
  })

  it("records the quota frame", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(
      { kind: "usage", scope: "day", current: 3, limit: 10, resetsAtEpoch: 1 },
      h.target
    )

    expect(h.usages).toEqual([{ current: 3, limit: 10 }])
  })
})

describe("createChatTurnFold — errors", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("drops the bubble silently when the user stopped an empty turn", () => {
    const h = harness([message("a-1", { streaming: true })])
    h.target.messageId = "a-1" as ChatMessageId

    createChatTurnFold(h.deps).applyTurnEvent(errorEvent({ code: "stopped_empty" }), h.target)

    expect(h.messages.value).toEqual([])
    expect(h.target.messageId).toBeNull()
  })

  it("turns the streaming bubble into a failed one, keeping its id", () => {
    const h = harness([message("a-1", { streaming: true, content: "half", statusKey: "s" })])
    h.target.messageId = "a-1" as ChatMessageId

    createChatTurnFold(h.deps).applyTurnEvent(errorEvent(), h.target)

    expect(h.messages.value[0].id).toBe("a-1")
    expect(h.messages.value[0].content).toBe("")
    expect(h.messages.value[0].statusKey).toBeUndefined()
    expect(h.messages.value[0].error).toEqual({ kind: "failed", code: "server_error" })
  })

  it("synthesizes a bubble when the failure preceded the placeholder", () => {
    const h = harness([message("u-1", { role: "user" })])

    createChatTurnFold(h.deps).applyTurnEvent(errorEvent({ code: "network" }), h.target)

    expect(h.messages.value).toHaveLength(2)
    expect(h.messages.value[1].error).toEqual({ kind: "failed", code: "network" })
    expect(h.messages.value[1].sessionId).toBe(SESSION)
  })

  it("builds the retry deadline on the device clock from the server's duration", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(
      errorEvent({ code: "rate_limited", retryAfter: 30, resetsAtEpoch: 9 }),
      h.target
    )

    expect(h.messages.value[0].error).toMatchObject({ retryAfterAt: NOW + 30_000 })
  })

  it("falls back to the server's absolute reset when no duration is given", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(
      errorEvent({ code: "rate_limited", resetsAtEpoch: 1_800_000_000 }),
      h.target
    )

    expect(h.messages.value[0].error).toMatchObject({ retryAfterAt: 1_800_000_000_000 })
  })

  it("locks the composer for a fixed window on a bare rate limit", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(errorEvent({ code: "rate_limited" }), h.target)

    expect(h.messages.value[0].error).toMatchObject({
      retryAfterAt: NOW + BARE_RATE_LIMIT_LOCKOUT_MS,
    })
    expect(h.rateLimits).toHaveLength(1)
  })

  it("ignores a non-positive retry-after and a non-positive reset", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(
      errorEvent({ code: "network", retryAfter: 0, resetsAtEpoch: 0 }),
      h.target
    )

    expect(h.messages.value[0].error).toEqual({ kind: "failed", code: "network" })
  })

  it("leaves the composer usable for a network failure carrying a deadline", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(
      errorEvent({ code: "network", retryAfter: 30 }),
      h.target
    )

    expect(h.rateLimits).toEqual([])
    expect(h.messages.value[0].error).toMatchObject({ retryAfterAt: NOW + 30_000 })
  })

  it("carries the quota tier onto the failed bubble", () => {
    const h = harness()

    createChatTurnFold(h.deps).applyTurnEvent(
      errorEvent({ code: "rate_limited", retryAfter: 30, tier: "free", keyType: "user" }),
      h.target
    )

    expect(h.messages.value[0].error).toMatchObject({ tier: "free" })
    expect(h.rateLimits[0].tier).toBe("free")
  })
})

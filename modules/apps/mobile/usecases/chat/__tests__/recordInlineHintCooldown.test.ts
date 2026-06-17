import { describe, expect, it, vi } from "vitest"
import { inlineHintToRuleKind, recordInlineHintCooldown } from "../recordInlineHintCooldown.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { IProactiveStateRepository } from "@lib/domain/ports/proactiveStateRepository.js"

function payload(kind: ChatActionPayload["kind"]): ChatActionPayload {
  return { kind, id: "a1" } as ChatActionPayload
}

function repo(over: Partial<IProactiveStateRepository> = {}): IProactiveStateRepository {
  return {
    attach: vi.fn().mockResolvedValue(undefined),
    listByPrepStates: async () => [],
    listSeenable: async () => [],
    markSeen: async () => {},
    markDismissed: async () => {},
    markSuperseded: async () => {},
    setVisibility: async () => {},
    setPrepState: async () => {},
    deleteByRule: async () => {},
    countActiveByRuleDate: async () => 0,
    listByRuleStates: async () => [],
    deleteByChatMessageId: async () => {},
    ...over,
  } as IProactiveStateRepository
}

describe("inlineHintToRuleKind", () => {
  it("maps enable_daily_reminder → enable_notifications_hint", () => {
    expect(inlineHintToRuleKind("enable_daily_reminder")).toBe("enable_notifications_hint")
  })

  it("maps configure_smart_library → smart_library_hint", () => {
    expect(inlineHintToRuleKind("configure_smart_library")).toBe("smart_library_hint")
  })

  it("returns null for kinds with no autonomous-rule counterpart", () => {
    expect(inlineHintToRuleKind("upgrade_to_pro")).toBeNull()
    expect(inlineHintToRuleKind("queue_next_track")).toBeNull()
    expect(inlineHintToRuleKind("share_pdf")).toBeNull()
  })
})

describe("recordInlineHintCooldown", () => {
  it("attaches a ready row with local-tz ruleDate + unix-sec preparedAt", async () => {
    const attach = vi.fn().mockResolvedValue(undefined)
    const now = new Date(2026, 4, 24, 14, 30, 0) // 2026-05-24 local
    await recordInlineHintCooldown(
      {
        chatMessageId: "m1" as ChatMessageId,
        payload: payload("enable_daily_reminder"),
        now,
      },
      { proactiveState: repo({ attach }) }
    )
    expect(attach).toHaveBeenCalledWith(
      "m1",
      "enable_notifications_hint",
      "2026-05-24",
      "ready",
      Math.floor(now.getTime() / 1000)
    )
  })

  it("noops for action kinds without an autonomous-rule counterpart", async () => {
    const attach = vi.fn().mockResolvedValue(undefined)
    await recordInlineHintCooldown(
      {
        chatMessageId: "m1" as ChatMessageId,
        payload: payload("upgrade_to_pro"),
        now: new Date(),
      },
      { proactiveState: repo({ attach }) }
    )
    expect(attach).not.toHaveBeenCalled()
  })

  it("pads single-digit month and day to 2 digits", async () => {
    const attach = vi.fn().mockResolvedValue(undefined)
    const now = new Date(2026, 0, 3, 9, 5) // 2026-01-03
    await recordInlineHintCooldown(
      {
        chatMessageId: "m1" as ChatMessageId,
        payload: payload("configure_smart_library"),
        now,
      },
      { proactiveState: repo({ attach }) }
    )
    expect(attach.mock.calls[0][2]).toBe("2026-01-03")
  })
})

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createApp } from "vue"

const ctx = vi.hoisted(() => ({
  refreshSessions: vi.fn<() => Promise<void>>(),
  reportError: vi.fn(),
}))

vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({
    unseenProactiveSessionIds: new Set(["s-1"]),
    refreshSessions: ctx.refreshSessions,
  }),
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError: ctx.reportError }))

import { useProactiveInboxBadge } from "../useProactiveInboxBadge.js"

describe("useProactiveInboxBadge", () => {
  it("reports a session refresh that fails on mount and keeps the count", async () => {
    const boom = new Error("database is locked")
    ctx.refreshSessions.mockRejectedValueOnce(boom)
    let count!: ReturnType<typeof useProactiveInboxBadge>["count"]
    const app = createApp({
      setup() {
        count = useProactiveInboxBadge().count
        return () => null
      },
    })
    app.mount(document.createElement("div"))
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(ctx.reportError).toHaveBeenCalledWith("proactive", boom)
    expect(count.value).toBe(1)
    app.unmount()
  })
})

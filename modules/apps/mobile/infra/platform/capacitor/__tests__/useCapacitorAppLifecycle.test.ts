import { describe, expect, it, vi } from "vitest"

type Listener = (state: { isActive: boolean; extra?: string }) => void
const listeners: Listener[] = []
const remove = vi.fn(async () => undefined)

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: async (event: string, listener: Listener) => {
      if (event === "appStateChange") listeners.push(listener)
      return { remove }
    },
    getState: async () => ({ isActive: false, extra: "x" }),
  },
}))

import { useCapacitorAppLifecycle } from "../useCapacitorAppLifecycle.js"

describe("useCapacitorAppLifecycle", () => {
  it("forwards each foreground transition as its active flag alone", async () => {
    const seen: unknown[] = []
    const subscription = await useCapacitorAppLifecycle().onStateChange((s) => seen.push(s))

    listeners[0]!({ isActive: true, extra: "ignored" })
    listeners[0]!({ isActive: false })

    expect(seen).toEqual([{ isActive: true }, { isActive: false }])
    await subscription.remove()
    expect(remove).toHaveBeenCalledOnce()
  })

  it("reads the current state", async () => {
    expect(await useCapacitorAppLifecycle().getState()).toEqual({ isActive: false })
  })
})

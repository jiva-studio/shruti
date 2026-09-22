import { describe, it, expect, vi, beforeEach } from "vitest"

interface MockButton {
  text: string
  role?: string
  side?: "start" | "end"
  handler?: () => boolean | void | Promise<boolean | void>
}

interface MockToast {
  options: Record<string, unknown>
  buttons: MockButton[]
  /** Ends the toast the way Ionic would (timeout, gesture, a button, …). */
  settle: (role?: string) => void
}

const { present, create, dismiss, toasts } = vi.hoisted(() => {
  const present = vi.fn(() => Promise.resolve())
  const dismiss = vi.fn()
  const toasts: MockToast[] = []
  const create = vi.fn((options: Record<string, unknown>) => {
    let settle!: (detail: { role?: string }) => void
    const dismissed = new Promise<{ role?: string }>((resolve) => {
      settle = resolve
    })
    const toast: MockToast = {
      options,
      buttons: (options.buttons as MockButton[] | undefined) ?? [],
      settle: (role) => settle({ role }),
    }
    toasts.push(toast)
    return Promise.resolve({
      ...toast,
      present,
      onDidDismiss: () => dismissed,
      dismiss: (_data?: unknown, role?: string) => {
        dismiss(role)
        settle({ role })
        return Promise.resolve(true)
      },
    })
  })
  return { present, create, dismiss, toasts }
})

vi.mock("@ionic/vue", () => ({
  toastController: { create },
}))

type UseToast = typeof import("../useToast.js").useToast

// useToast keeps the on-screen toast in module state, so each test needs a
// fresh module.
let useToast: UseToast

/** Wait until `count` toasts have been created, then hand back the newest. */
async function presented(count = 1): Promise<MockToast> {
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(count))
  return toasts[count - 1]!
}

/** Let every pending microtask settle, so "did not present" means it. */
async function idle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("useToast", () => {
  beforeEach(async () => {
    create.mockClear()
    present.mockClear()
    dismiss.mockClear()
    toasts.length = 0
    vi.resetModules()
    ;({ useToast } = await import("../useToast.js"))
  })

  it("presents the message with default duration / position", async () => {
    await useToast().show("hello")
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ message: "hello", duration: 1800, position: "top" })
    )
    expect(present).toHaveBeenCalledOnce()
  })

  it("info uses primary colour, error uses danger", async () => {
    const toast = useToast()
    await toast.info("ok")
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ color: "primary" }))
    await toast.error("nope")
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ color: "danger" }))
  })

  it("per-call options override factory defaults", async () => {
    const toast = useToast({ durationMs: 1000, position: "bottom", color: "warning" })
    await toast.show("a")
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ duration: 1000, position: "bottom", color: "warning" })
    )
    await toast.show("b", { durationMs: 50, position: "middle", color: "success" })
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ duration: 50, position: "middle", color: "success" })
    )
  })

  it("info/error honour an explicit colour override", async () => {
    await useToast().info("x", { color: "tertiary" })
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ color: "tertiary" }))
  })

  it("show/info/error pass no buttons and resolve on presentation, not dismissal", async () => {
    const toast = useToast()
    await toast.show("a")
    await toast.info("b")
    await toast.error("c")
    for (const call of create.mock.calls) {
      expect(call[0]).not.toHaveProperty("buttons")
      expect(call[0]).not.toHaveProperty("layout")
    }
    // Nothing resolved the last toast's dismissal, yet all three awaits completed.
    expect(present).toHaveBeenCalledTimes(3)
  })

  it("error defaults to a longer duration than show/info", async () => {
    const toast = useToast()
    await toast.show("a")
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 1800 }))
    await toast.error("b")
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 4000 }))
    await toast.error("c", { durationMs: 100 })
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 100 }))
    await useToast({ durationMs: 700 }).error("d")
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 700 }))
  })

  it("passes buttons through to toastController.create", async () => {
    const outcome = useToast().action("limit reached", {
      buttons: [{ text: "Download anyway", role: "confirm", side: "end" }],
      durationMs: 20000,
      color: "warning",
    })
    const toast = await presented()
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "limit reached",
        duration: 20000,
        color: "warning",
        buttons: [
          expect.objectContaining({ text: "Download anyway", role: "confirm", side: "end" }),
        ],
      })
    )
    toast.settle("timeout")
    await outcome
  })

  it("reports a pressed button with its index and role, and runs its handler", async () => {
    const handler = vi.fn()
    const outcome = useToast().action("limit reached", {
      buttons: [
        { text: "Cancel", role: "cancel" },
        { text: "Download anyway", handler },
      ],
    })
    const toast = await presented()
    await toast.buttons[1]!.handler?.()
    toast.settle(undefined)
    expect(await outcome).toEqual({ kind: "pressed", index: 1, role: undefined })
    expect(handler).toHaveBeenCalledOnce()
  })

  it("reports expiry and dismissal apart from a press", async () => {
    const toast = useToast()

    const expired = toast.action("a", { buttons: [{ text: "Go" }] })
    ;(await presented()).settle("timeout")
    expect(await expired).toEqual({ kind: "expired" })

    const swiped = toast.action("b", { buttons: [{ text: "Go" }] })
    ;(await presented(2)).settle("gesture")
    expect(await swiped).toEqual({ kind: "dismissed", role: "gesture" })
  })

  it("forwards a handler's veto so the toast can stay open", async () => {
    const outcome = useToast().action("a", {
      buttons: [{ text: "Go", handler: () => false }],
    })
    const toast = await presented()
    expect(await toast.buttons[0]!.handler?.()).toBe(false)
    toast.settle("timeout")
    // The press was still recorded — Ionic, not kit, decides on the veto.
    expect(await outcome).toEqual({ kind: "pressed", index: 0, role: undefined })
  })

  it("action falls back to the instructional duration and factory defaults", async () => {
    const outcome = useToast({ position: "bottom" }).action("a", { buttons: [{ text: "Go" }] })
    const toast = await presented()
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ duration: 4000, position: "bottom" })
    )
    toast.settle("timeout")
    await outcome
  })

  describe("swipe (#24)", () => {
    it("enables the vertical swipe gesture on every toast", async () => {
      const toast = useToast()
      await toast.show("a")
      await toast.info("b")
      await toast.error("c")
      const outcome = toast.action("d", { buttons: [{ text: "Go" }] })
      const actionable = await presented(4)
      for (const call of create.mock.calls) {
        expect(call[0]).toMatchObject({ swipeGesture: "vertical" })
      }
      actionable.settle("timeout")
      await outcome
    })

    it("reports a swipe as dismissed, never pressed or expired", async () => {
      const handler = vi.fn()
      const outcome = useToast().action("limit reached", {
        buttons: [{ text: "Download anyway", handler }],
        durationMs: 20000,
      })
      ;(await presented()).settle("gesture")
      expect(await outcome).toEqual({ kind: "dismissed", role: "gesture" })
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe("button layout (#25)", () => {
    it("stacks action buttons beneath the message by default", async () => {
      const outcome = useToast().action("a", { buttons: [{ text: "Всё равно скачать" }] })
      const toast = await presented()
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "stacked" }))
      toast.settle("timeout")
      await outcome
    })

    it("honours an explicit baseline layout", async () => {
      const outcome = useToast().action("a", {
        buttons: [{ text: "Go" }],
        layout: "baseline",
      })
      const toast = await presented()
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "baseline" }))
      toast.settle("timeout")
      await outcome
    })
  })

  describe("stacking policy (#26)", () => {
    it("dismisses nothing when the screen is empty", async () => {
      await useToast().show("a")
      expect(dismiss).not.toHaveBeenCalled()
    })

    it("replaces the live toast instead of piling onto it", async () => {
      const toast = useToast()
      await toast.show("first")
      await toast.show("second")
      expect(dismiss).toHaveBeenCalledExactlyOnceWith("replaced")
      expect(present).toHaveBeenCalledTimes(2)
      expect(create.mock.calls.map((call) => call[0]!.message)).toEqual(["first", "second"])
    })

    it("makes a queued toast wait for the live one", async () => {
      const toast = useToast()
      await toast.show("status")
      const outcome = toast.action("limit reached", {
        buttons: [{ text: "Download anyway" }],
        policy: "queue",
      })
      await idle()
      expect(create).toHaveBeenCalledTimes(1)
      expect(dismiss).not.toHaveBeenCalled()

      toasts[0]!.settle("timeout")
      const queued = await presented(2)
      queued.settle("timeout")
      expect(await outcome).toEqual({ kind: "expired" })
    })

    it("does not let a later toast replace a queued one", async () => {
      const toast = useToast()
      const outcome = toast.action("limit reached", {
        buttons: [{ text: "Download anyway" }],
        durationMs: 20000,
        policy: "queue",
      })
      const actionable = await presented()

      const later = toast.error("download failed")
      await idle()
      expect(create).toHaveBeenCalledTimes(1)
      expect(dismiss).not.toHaveBeenCalled()

      await actionable.buttons[0]!.handler?.()
      actionable.settle(undefined)
      expect(await outcome).toEqual({ kind: "pressed", index: 0, role: undefined })

      await later
      expect(create).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "download failed" })
      )
    })

    it("takes the policy from factory defaults", async () => {
      const toast = useToast({ policy: "queue" })
      await toast.show("first")
      const second = toast.show("second")
      await idle()
      expect(create).toHaveBeenCalledTimes(1)
      toasts[0]!.settle("timeout")
      await second
      expect(create).toHaveBeenCalledTimes(2)
    })

    it("presents queued toasts in call order", async () => {
      const toast = useToast({ policy: "queue" })
      await toast.show("first")
      const second = toast.show("second")
      const third = toast.show("third")
      toasts[0]!.settle("timeout")
      await second
      toasts[1]!.settle("timeout")
      await third
      expect(create.mock.calls.map((call) => call[0]!.message)).toEqual([
        "first",
        "second",
        "third",
      ])
    })
  })

  describe("an answer outlives a status report (#29)", () => {
    it("keeps a live action toast on screen while a status toast waits its turn", async () => {
      const toast = useToast()
      const outcome = toast.action("limit reached", {
        buttons: [{ text: "Download anyway" }],
        durationMs: 20000,
      })
      const prompt = await presented()

      const status = toast.error("download failed")
      await idle()
      expect(create).toHaveBeenCalledTimes(1)
      expect(dismiss).not.toHaveBeenCalled()

      await prompt.buttons[0]!.handler?.()
      prompt.settle(undefined)
      expect(await outcome).toEqual({ kind: "pressed", index: 0, role: undefined })

      await status
      expect(create).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "download failed" })
      )
    })

    it("reports the expiry of an unanswered action toast, never a replacement", async () => {
      const toast = useToast()
      const outcome = toast.action("limit reached", {
        buttons: [{ text: "Download anyway" }],
        durationMs: 20000,
      })
      const prompt = await presented()
      const status = toast.info("queued")
      await idle()

      prompt.settle("timeout")
      expect(await outcome).toEqual({ kind: "expired" })
      await status
    })

    it("still lets an action toast take the screen from a status toast", async () => {
      const toast = useToast()
      await toast.show("status")
      const outcome = toast.action("limit reached", { buttons: [{ text: "Download anyway" }] })
      const prompt = await presented(2)
      expect(dismiss).toHaveBeenCalledExactlyOnceWith("replaced")
      prompt.settle("timeout")
      await outcome
    })
  })
})

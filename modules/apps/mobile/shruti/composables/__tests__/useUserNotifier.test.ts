// @vitest-environment jsdom
import { createApp, type App as VueApp } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  permission: "granted" as "granted" | "denied",
  isActive: true,
  stateListener: undefined as ((s: { isActive: boolean }) => void) | undefined,
  route: { name: "home", query: {} as Record<string, unknown> },
  sessionTitles: {} as Record<string, string | null>,
  pendingTurns: [] as { assistantMessageId: string; sessionId: string; createdAt: number }[],
  schedule: vi.fn<(options: Record<string, unknown>) => Promise<void>>(async () => {}),
  cancel: vi.fn(async () => {}),
  markAnswerUnread: vi.fn(async () => {}),
  routerReplace: vi.fn(),
  toast: {
    style: {} as Record<string, unknown>,
    addEventListener: vi.fn(),
    present: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
  },
  toastOptions: undefined as Record<string, unknown> | undefined,
}))

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@capacitor/app", () => ({
  App: {
    getState: async () => ({ isActive: harness.isActive }),
    addListener: async (_e: string, fn: (s: { isActive: boolean }) => void) => {
      harness.stateListener = fn
      return { remove: vi.fn() }
    },
  },
}))
vi.mock("@ionic/vue", () => ({
  toastController: {
    create: async (options: Record<string, unknown>) => {
      harness.toastOptions = options
      return harness.toast
    },
  },
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    notifications: {
      checkPermission: async () => harness.permission,
      schedule: harness.schedule,
      cancel: harness.cancel,
    },
  }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({
    sessionTitleFor: (id: string) => harness.sessionTitles[id] ?? null,
    listPendingTurns: async () => harness.pendingTurns,
    markAnswerUnread: harness.markAnswerUnread,
  }),
}))
vi.mock("@shruti/router/index.js", () => ({
  default: {
    get currentRoute() {
      return { value: harness.route }
    },
    replace: harness.routerReplace,
  },
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))

import { emitNotify } from "@shruti/notifications/notifyEvents.js"
import { emitTurnSettled, emitTurnStarted } from "@shruti/chat/turnNotificationEvents.js"
import { notificationIdFor } from "@shruti/proactive/hash.js"
import { useUserNotifier } from "../useUserNotifier.js"

// jsdom has no media playback; the toast's chime would log on every toast.
HTMLMediaElement.prototype.play = async () => undefined

const mounted: VueApp[] = []

function mount(): VueApp {
  const app = createApp({
    setup() {
      useUserNotifier()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  mounted.push(app)
  return app
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

async function mountAndSettle(): Promise<VueApp> {
  const app = mount()
  await flush()
  return app
}

function chatIntent(over: Record<string, unknown> = {}) {
  return {
    title: "notifications.chatAnswerReadyTitle",
    body: "The answer is ready",
    sessionId: "sess-1",
    notificationId: 42,
    whenBackground: "notify" as const,
    ...over,
  }
}

describe("useUserNotifier — foreground", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.permission = "granted"
    harness.isActive = true
    harness.route = { name: "home", query: {} }
    harness.sessionTitles = {}
    harness.pendingTurns = []
    harness.toastOptions = undefined
    harness.toast.style = {}
  })
  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount()
  })

  it("toasts instead of firing an OS notification", async () => {
    await mountAndSettle()
    emitNotify(chatIntent())
    await flush()

    expect(harness.toast.present).toHaveBeenCalledTimes(1)
    expect(harness.toastOptions).toMatchObject({
      message: "The answer is ready",
      position: "top",
    })
    expect(harness.schedule).not.toHaveBeenCalled()
  })

  it("heads the toast with the thread's own name, falling back to the generic title", async () => {
    harness.sessionTitles = { "sess-1": "On the Gita" }
    await mountAndSettle()
    emitNotify(chatIntent())
    await flush()
    expect(harness.toastOptions!.header).toBe("On the Gita")

    emitNotify(chatIntent({ sessionId: "sess-untitled" }))
    await flush()
    expect(harness.toastOptions!.header).toBe("notifications.chatAnswerReadyTitle")
  })

  it("says nothing when the user is already reading that thread", async () => {
    harness.route = { name: "chat", query: { session: "sess-1" } }
    await mountAndSettle()
    emitNotify(chatIntent())
    await flush()

    expect(harness.toast.present).not.toHaveBeenCalled()
    // The answer is on screen, so it is not marked unread either.
    expect(harness.markAnswerUnread).not.toHaveBeenCalled()
  })

  it("still toasts while the user reads a different thread", async () => {
    harness.route = { name: "chat", query: { session: "sess-other" } }
    await mountAndSettle()
    emitNotify(chatIntent())
    await flush()

    expect(harness.toast.present).toHaveBeenCalledTimes(1)
    expect(harness.markAnswerUnread).toHaveBeenCalledWith("sess-1")
  })

  it("opens the thread when the toast is tapped", async () => {
    await mountAndSettle()
    emitNotify(chatIntent())
    await flush()

    const [event, listener] = harness.toast.addEventListener.mock.calls[0] as [string, () => void]
    expect(event).toBe("click")
    listener()
    expect(harness.routerReplace).toHaveBeenCalledWith({
      name: "chat",
      query: { session: "sess-1" },
    })
  })

  it("leaves a toast with no thread untappable", async () => {
    await mountAndSettle()
    emitNotify(chatIntent({ sessionId: undefined, notificationId: undefined }))
    await flush()

    expect(harness.toast.addEventListener).not.toHaveBeenCalled()
    expect(harness.markAnswerUnread).not.toHaveBeenCalled()
  })

  it("calls off the pre-armed OS notification once the answer lands in-app", async () => {
    await mountAndSettle()
    emitNotify(chatIntent())
    await flush()
    expect(harness.cancel).toHaveBeenCalledWith(42)
  })

  it("leaves a proactive message's own delivery alone", async () => {
    await mountAndSettle()
    emitNotify(chatIntent({ whenBackground: "skip", notificationId: undefined }))
    await flush()

    expect(harness.toast.present).toHaveBeenCalledTimes(1)
    expect(harness.cancel).not.toHaveBeenCalled()
    // Proactive rows track their own unseen state.
    expect(harness.markAnswerUnread).not.toHaveBeenCalled()
  })
})

describe("useUserNotifier — background", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.permission = "granted"
    harness.isActive = false
    harness.route = { name: "home", query: {} }
    harness.sessionTitles = {}
    harness.pendingTurns = []
  })
  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount()
  })

  it("fires an OS notification instead of a toast", async () => {
    harness.sessionTitles = { "sess-1": "On the Gita" }
    await mountAndSettle()
    emitNotify(chatIntent())
    await flush()

    expect(harness.toast.present).not.toHaveBeenCalled()
    expect(harness.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        title: "On the Gita",
        body: "The answer is ready",
        extra: { chatSessionId: "sess-1" },
      })
    )
  })

  it("stays silent for an emitter that delivers its own background push", async () => {
    await mountAndSettle()
    emitNotify(chatIntent({ whenBackground: "skip" }))
    await flush()

    expect(harness.schedule).not.toHaveBeenCalled()
    expect(harness.toast.present).not.toHaveBeenCalled()
  })

  it("stays silent when the user never granted notification permission", async () => {
    harness.permission = "denied"
    await mountAndSettle()
    emitNotify(chatIntent())
    await flush()

    expect(harness.schedule).not.toHaveBeenCalled()
  })
})

describe("useUserNotifier — the pre-armed answer alarm", () => {
  const MESSAGE = "assistant-msg-1"

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0, 0))
    harness.permission = "granted"
    harness.isActive = true
    harness.route = { name: "home", query: {} }
    harness.sessionTitles = {}
    harness.pendingTurns = []
  })
  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount()
    vi.useRealTimers()
  })

  it("arms an alarm a minute out the moment a turn starts", async () => {
    await mountAndSettle()
    emitTurnStarted({ assistantMessageId: MESSAGE, sessionId: "sess-1" })
    await flush()

    expect(harness.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: notificationIdFor(MESSAGE),
        at: Date.now() + 60_000,
        extra: { chatSessionId: "sess-1" },
      })
    )
  })

  it("calls the alarm off when the turn fails or is stopped", async () => {
    await mountAndSettle()
    emitTurnSettled({ assistantMessageId: MESSAGE, sessionId: "sess-1", ok: false })
    await flush()
    expect(harness.cancel).toHaveBeenCalledWith(notificationIdFor(MESSAGE))
  })

  it("calls the alarm off for an answer the user must not be told about", async () => {
    await mountAndSettle()
    emitTurnSettled({ assistantMessageId: MESSAGE, sessionId: "sess-1", ok: true, silent: true })
    await flush()
    expect(harness.cancel).toHaveBeenCalledWith(notificationIdFor(MESSAGE))
  })

  it("leaves the alarm standing on a successful settle, for the notify path to replace", async () => {
    await mountAndSettle()
    emitTurnSettled({ assistantMessageId: MESSAGE, sessionId: "sess-1", ok: true })
    await flush()
    expect(harness.cancel).not.toHaveBeenCalled()
  })

  it("arms nothing without notification permission", async () => {
    harness.permission = "denied"
    await mountAndSettle()
    emitTurnStarted({ assistantMessageId: MESSAGE, sessionId: "sess-1" })
    await flush()
    expect(harness.schedule).not.toHaveBeenCalled()
  })

  it("re-arms pending turns when the user leaves and cancels when they come back", async () => {
    harness.pendingTurns = [
      { assistantMessageId: MESSAGE, sessionId: "sess-1", createdAt: Date.now() },
    ]
    await mountAndSettle()

    harness.stateListener!({ isActive: false })
    await flush()
    expect(harness.schedule).toHaveBeenCalledTimes(1)
    expect(harness.cancel).not.toHaveBeenCalled()

    harness.stateListener!({ isActive: true })
    await flush()
    expect(harness.cancel).toHaveBeenCalledWith(notificationIdFor(MESSAGE))
  })

  it("never arms an alarm in the past for a turn that started long ago", async () => {
    harness.pendingTurns = [
      { assistantMessageId: MESSAGE, sessionId: "sess-1", createdAt: Date.now() - 600_000 },
    ]
    await mountAndSettle()
    harness.stateListener!({ isActive: false })
    await flush()

    expect(harness.schedule.mock.calls[0][0]).toMatchObject({ at: Date.now() + 2_000 })
  })

  it("stops reacting to turns once unmounted", async () => {
    const app = await mountAndSettle()
    mounted.splice(mounted.indexOf(app), 1)
    app.unmount()

    emitTurnStarted({ assistantMessageId: MESSAGE, sessionId: "sess-1" })
    emitNotify(chatIntent())
    await flush()

    expect(harness.schedule).not.toHaveBeenCalled()
    expect(harness.toast.present).not.toHaveBeenCalled()
  })
})

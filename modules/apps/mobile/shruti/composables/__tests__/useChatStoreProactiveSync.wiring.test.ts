// @vitest-environment jsdom
import { createApp, type App } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
  unseen: new Set<string>(),
  refreshSessions: vi.fn(async () => {}),
}))

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({
    refreshSessions: store.refreshSessions,
    get unseenProactiveSessionIds() {
      return store.unseen
    },
  }),
}))

import { emit } from "@shruti/proactive/events.js"
import { onNotify, type NotifyIntent } from "@shruti/notifications/notifyEvents.js"
import { useChatStoreProactiveSync } from "../useChatStoreProactiveSync.js"

let intents: NotifyIntent[] = []
let stopListening: (() => void) | undefined

function mount(): App {
  const app = createApp({
    setup() {
      useChatStoreProactiveSync()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return app
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Run a scheduler tick that preps `prepped` rows, ending with `unseen` unseen. */
async function tick(prepped: number, unseen: readonly string[]): Promise<void> {
  emit("tick-ready")
  for (let i = 0; i < prepped; i++) emit("row-prepped")
  store.unseen = new Set(unseen)
  emit("tick-settled")
  await flush()
}

describe("useChatStoreProactiveSync", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.unseen = new Set()
    store.refreshSessions.mockResolvedValue(undefined)
    intents = []
    stopListening = onNotify((intent) => intents.push(intent))
  })

  afterEach(() => {
    stopListening?.()
  })

  it("toasts once for a tick that surfaced a single message", async () => {
    const app = mount()
    await tick(1, ["sess-a"])

    expect(intents).toHaveLength(1)
    expect(intents[0].title).toBe("notifications.proactiveNewMessageTitle")
    expect(intents[0].body).toBe("notifications.proactiveNewMessageToast")
    expect(intents[0].sessionId).toBe("sess-a")
    expect(intents[0].whenBackground).toBe("skip")
    app.unmount()
  })

  it("coalesces a batch into one toast carrying the count", async () => {
    const app = mount()
    await tick(3, ["sess-a", "sess-b", "sess-c"])

    expect(intents).toHaveLength(1)
    expect(intents[0].title).toBe("notifications.proactiveNewMessagesTitle")
    expect(intents[0].body).toBe('notifications.proactiveNewMessagesToast:{"count":3}')
    expect(intents[0].sessionId).toBe("sess-a")
    app.unmount()
  })

  it("counts only what this tick added, not what was already unseen", async () => {
    store.unseen = new Set(["sess-old"])
    const app = mount()
    await tick(2, ["sess-old", "sess-a", "sess-b"])

    expect(intents[0].body).toBe('notifications.proactiveNewMessagesToast:{"count":2}')
    app.unmount()
  })

  it("says nothing for a tick that prepped nothing", async () => {
    const app = mount()
    emit("tick-ready")
    emit("tick-settled")
    await flush()

    expect(intents).toHaveLength(0)
    app.unmount()
  })

  it("says nothing when a prepped row did not surface a new message", async () => {
    store.unseen = new Set(["sess-a"])
    const app = mount()
    await tick(1, ["sess-a"])

    expect(intents).toHaveLength(0)
    app.unmount()
  })

  it("says nothing when the user opened a session while the tick ran", async () => {
    store.unseen = new Set(["sess-a", "sess-b"])
    const app = mount()
    await tick(1, ["sess-b"])

    expect(intents).toHaveLength(0)
    app.unmount()
  })

  it("does not carry a tick's prep over into the next one", async () => {
    const app = mount()
    await tick(1, ["sess-a"])
    expect(intents).toHaveLength(1)

    // A tick that preps nothing must stay silent even though the unseen set
    // grew for some other reason (a row becoming due, a sync landing).
    emit("tick-ready")
    store.unseen = new Set(["sess-a", "sess-b"])
    emit("tick-settled")
    await flush()

    expect(intents).toHaveLength(1)
    app.unmount()
  })

  it("keeps the session list current on every proactive signal", async () => {
    const app = mount()
    emit("tick-ready")
    emit("row-created")
    emit("row-prepped")
    await flush()

    expect(store.refreshSessions).toHaveBeenCalledTimes(3)
    app.unmount()
  })

  it("stops reacting once unmounted", async () => {
    const app = mount()
    app.unmount()
    await tick(1, ["sess-a"])

    expect(store.refreshSessions).not.toHaveBeenCalled()
    expect(intents).toHaveLength(0)
  })

  it("survives a refresh that throws instead of taking the tick down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    store.refreshSessions.mockRejectedValue(new Error("query failed"))
    const app = mount()

    // A failing refresh must not swallow the tick: the toast still lands from
    // whatever the store currently holds.
    await tick(1, ["sess-a"])
    expect(intents).toHaveLength(1)
    app.unmount()
  })
})

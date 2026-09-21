import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { ChatSession } from "@shruti/stores/useChatStore.js"

/* -- Module doubles ----------------------------------------------------- */

interface AlertButton {
  readonly text: string
  readonly role?: string
  readonly handler?: () => void
}

interface AlertOptions {
  readonly header: string
  readonly message: string
  readonly buttons: readonly AlertButton[]
}

const alerts: AlertOptions[] = []
let presentedAlerts = 0

const navigations: { name?: string; query?: Record<string, unknown> }[] = []
const toasts: { level: string; text: string }[] = []
const reported: unknown[] = []

/** A chat store with real state, so assertions read state and not calls. */
const store = {
  sessions: [] as ChatSession[],
  activeSessionId: null as string | null,
  refreshCount: 0,
  clearAllFails: false,
  searchSessions(query: string): ChatSession[] {
    const q = query.trim().toLowerCase()
    return q
      ? store.sessions.filter((s) => (s.title ?? "").toLowerCase().includes(q))
      : [...store.sessions]
  },
  startNewSession(): void {
    store.activeSessionId = null
  },
  async refreshSessions(): Promise<void> {
    store.refreshCount += 1
  },
  async deleteSession(id: string): Promise<void> {
    store.sessions = store.sessions.filter((s) => s.id !== id)
    if (store.activeSessionId === id) store.activeSessionId = null
  },
  async clearAll(): Promise<void> {
    if (store.clearAllFails) throw new Error("network down")
    store.sessions = []
    store.activeSessionId = null
  },
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  alertController: {
    create: async (options: AlertOptions) => {
      alerts.push(options)
      return { present: async () => void (presentedAlerts += 1) }
    },
  },
}))
vi.mock("@shruti/router/index.js", () => ({
  default: {
    replace: (to: { name?: string; query?: Record<string, unknown> }) => void navigations.push(to),
  },
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({
    info: async (text: string) => void toasts.push({ level: "info", text }),
    error: async (text: string) => void toasts.push({ level: "error", text }),
  }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({ useChatStore: () => store }))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: (_scope: string, err: unknown) => void reported.push(err),
}))

const { useChatSessions } = await import("../useChatSessions.js")

/* -- Harness ------------------------------------------------------------ */

const session = (id: string, title: string): ChatSession =>
  ({ id, title, updatedAt: 0 }) as unknown as ChatSession

let routeSessionId: string | null = null
let ensured = 0

function build(): ReturnType<typeof useChatSessions> & {
  scrollReady: ReturnType<typeof ref<boolean>>
} {
  const scrollReady = ref(true)
  const api = useChatSessions({
    sessionIdFromRoute: () => routeSessionId,
    scrollReady,
    ensureSessionFromRoute: async () => void (ensured += 1),
  })
  return Object.assign(api, { scrollReady })
}

beforeEach(() => {
  store.sessions = [session("s1", "On bhakti"), session("s2", "About the Gita")]
  store.activeSessionId = "s1"
  store.refreshCount = 0
  store.clearAllFails = false
  routeSessionId = null
  ensured = 0
})

afterEach(() => {
  alerts.length = 0
  presentedAlerts = 0
  navigations.length = 0
  toasts.length = 0
  reported.length = 0
})

/** Press the button carrying this role on the most recent alert. */
function pressAlertButton(role: string): void {
  const button = alerts[alerts.length - 1].buttons.find((b) => b.role === role)
  button?.handler?.()
}

describe("the history list", () => {
  it("lists every session while the search box is empty", () => {
    expect(build().filteredSessions.value.map((s) => s.id)).toEqual(["s1", "s2"])
  })

  it("narrows to the matching sessions as the query changes", () => {
    const api = build()
    api.searchQuery.value = "gita"
    expect(api.filteredSessions.value.map((s) => s.id)).toEqual(["s2"])
    api.searchQuery.value = "bhakti"
    expect(api.filteredSessions.value.map((s) => s.id)).toEqual(["s1"])
  })

  it("follows the store when a session disappears", async () => {
    const api = build()
    await api.onDeleteSession("s1")
    expect(api.filteredSessions.value.map((s) => s.id)).toEqual(["s2"])
  })
})

describe("opening and closing the sheet", () => {
  it("refreshes, clears the query and opens", async () => {
    const api = build()
    api.searchQuery.value = "stale"
    await api.onOpenHistory()

    expect(store.refreshCount).toBe(1)
    expect(api.searchQuery.value).toBe("")
    expect(api.isHistoryOpen.value).toBe(true)
  })

  it("closes without touching the query", async () => {
    const api = build()
    await api.onOpenHistory()
    api.searchQuery.value = "gita"
    api.onCloseHistory()

    expect(api.isHistoryOpen.value).toBe(false)
    expect(api.searchQuery.value).toBe("gita")
  })
})

describe("starting a new session", () => {
  it("drops the session out of the url when one is deep-linked", () => {
    routeSessionId = "s1"
    build().onNewSession()
    expect(navigations).toEqual([{ name: "chat", query: {} }])
    expect(store.activeSessionId).toBeNull()
  })

  it("navigates nowhere when the url is already the chat root", () => {
    build().onNewSession()
    expect(navigations).toEqual([])
    expect(store.activeSessionId).toBeNull()
  })
})

describe("picking a session", () => {
  it("routes to it and blanks the thread until it has scrolled", async () => {
    const api = build()
    await api.onOpenHistory()
    await api.onPickSession("s2")

    expect(api.isHistoryOpen.value).toBe(false)
    expect(api.scrollReady.value).toBe(false)
    expect(navigations).toEqual([{ name: "chat", query: { session: "s2" } }])
    expect(ensured).toBe(0)
  })

  it("opens the session directly when the url already points at it", async () => {
    routeSessionId = "s2"
    const api = build()
    await api.onOpenHistory()
    await api.onPickSession("s2")

    expect(api.isHistoryOpen.value).toBe(false)
    expect(ensured).toBe(1)
    // No second navigation — the `?session=` watcher would never fire, and
    // re-routing to the same url would not re-open the thread.
    expect(navigations).toEqual([])
    expect(api.scrollReady.value).toBe(true)
  })
})

describe("deleting one session", () => {
  it("returns to the chat root when the open session is the one deleted", async () => {
    routeSessionId = "s1"
    await build().onDeleteSession("s1")

    expect(store.sessions.map((s) => s.id)).toEqual(["s2"])
    expect(navigations).toEqual([{ name: "chat", query: {} }])
  })

  it("stays where it is when another session is deleted", async () => {
    routeSessionId = "s1"
    await build().onDeleteSession("s2")

    expect(store.sessions.map((s) => s.id)).toEqual(["s1"])
    expect(navigations).toEqual([])
  })
})

describe("clearing the whole history", () => {
  it("asks first and does nothing until the destructive button is pressed", async () => {
    const api = build()
    await api.onDeleteAllSessions()

    expect(presentedAlerts).toBe(1)
    expect(alerts[0].buttons.map((b) => b.role)).toEqual(["cancel", "destructive"])
    expect(store.sessions).toHaveLength(2)

    pressAlertButton("cancel")
    expect(store.sessions).toHaveLength(2)
  })

  it("clears everything and says so when confirmed", async () => {
    routeSessionId = "s1"
    const api = build()
    api.searchQuery.value = "gita"
    await api.onDeleteAllSessions()

    pressAlertButton("destructive")
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(store.sessions).toEqual([])
    expect(api.searchQuery.value).toBe("")
    expect(navigations).toEqual([{ name: "chat", query: {} }])
    expect(toasts).toEqual([{ level: "info", text: "chat.clearedToast" }])
  })

  it("keeps the history and reports the failure when the clear fails", async () => {
    store.clearAllFails = true
    routeSessionId = "s1"
    const api = build()
    api.searchQuery.value = "gita"
    await api.onDeleteAllSessions()

    pressAlertButton("destructive")
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(store.sessions).toHaveLength(2)
    expect(api.searchQuery.value).toBe("gita")
    expect(navigations).toEqual([])
    expect(toasts).toEqual([{ level: "error", text: "chat.errNetwork" }])
    expect(reported).toHaveLength(1)
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, reactive } from "vue"

/* -- The global route, mutated in place like vue-router does ------------ */

const route = reactive<{ name: string; query: Record<string, string> }>({
  name: "chat",
  query: {},
})

function navigate(name: string, session?: string): void {
  route.name = name
  route.query = session ? { session } : {}
}

const replace = vi.fn()
const push = vi.fn()

vi.mock("vue-router", () => ({ useRoute: () => route }))
vi.mock("@shruti/router/index.js", () => ({
  // `currentRoute` is a ref over the SAME reactive object the page reads,
  // exactly as the router singleton and `useRoute()` relate at runtime.
  default: { currentRoute: { value: route }, replace, push },
}))

/* -- Module doubles ----------------------------------------------------- */

const store = reactive({
  messages: [] as { id: string; role: "user" | "assistant"; streaming?: boolean }[],
  sessions: [] as unknown[],
  activeSessionId: null as string | null,
  sending: false,
  unseenProactiveSessionIds: new Set<string>(),
  loadingFocusIds: new Set<string>(),
  inputFocusToken: 0,
  isComposeBlocked: false,
  composeBlockedUntil: null as number | null,
  chatUsage: null as unknown,
  searchSessions: () => [],
  refreshSessions: vi.fn(async () => {}),
  getLastSeenMessageId: vi.fn(async () => null),
  markSessionSeen: vi.fn(async () => {}),
  openSession: vi.fn(async (id: string) => {
    store.activeSessionId = id
    store.messages = [{ id: `${id}-m1`, role: "assistant" }]
  }),
  startNewSession: vi.fn(() => {
    store.activeSessionId = null
    store.messages = []
  }),
  sendMessage: vi.fn(async () => {}),
})

const pauseGroup = vi.fn()

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({ alertController: { create: vi.fn() } }))
vi.mock("@shruti/stores/useChatStore.js", () => ({ useChatStore: () => store }))
vi.mock("@shruti/stores/usePlayerStore.js", () => ({
  usePlayerStore: () => ({ open: false, trackId: null }),
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ info: vi.fn(), error: vi.fn(), show: vi.fn(), success: vi.fn() }),
}))
vi.mock("@shruti/composables/useTrackUserState.js", () => ({
  useTrackUserState: () => ({ listRecent: async () => [] }),
}))
vi.mock("@lib/chat/audio/useAudioOrchestrator.js", () => ({
  pauseGroup: (...args: unknown[]) => pauseGroup(...args),
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))

const { useChatController } = await import("../ChatView.controller.js")

/** Run the controller inside a real component so `onMounted` fires. The app
 *  is torn down after each test — the route is a module-level singleton here
 *  as it is at runtime, so a leftover page would keep watching it. */
let mounted: { unmount: () => void } | null = null

function mountController(): ReturnType<typeof useChatController> {
  let api!: ReturnType<typeof useChatController>
  const Host = defineComponent({
    setup() {
      api = useChatController()
      return () => h("div")
    },
  })
  const app = createApp(Host)
  app.mount(document.createElement("div"))
  mounted = app
  return api
}

/** Let the watchers flush and their awaited bodies settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

/**
 * Ionic keeps ChatView mounted after the tab changes and the route it reads
 * is the GLOBAL one, so both watchers below used to act on navigations that
 * belong to some other page. Being off-route is NOT the same as being
 * disabled (#1786's own tests make that point): the guard has to leave chat
 * state exactly as found, not clear it.
 */
describe("ChatView route watchers — only while chat is on screen (#1855)", () => {
  beforeEach(async () => {
    replace.mockClear()
    push.mockClear()
    pauseGroup.mockClear()
    store.openSession.mockClear()
    store.startNewSession.mockClear()
    store.activeSessionId = null
    store.messages = []
    navigate("chat")
  })

  afterEach(() => {
    mounted?.unmount()
    mounted = null
  })

  it("keeps the open session when the user navigates off chat", async () => {
    navigate("chat", "s1")
    mountController()
    await settle()
    expect(store.activeSessionId).toBe("s1")

    // Any hop out of an answer — a track link, Open in Studio, the paywall —
    // drops `?session=` from the global route.
    store.startNewSession.mockClear()
    navigate("track")
    await settle()

    expect(store.startNewSession).not.toHaveBeenCalled()
    expect(store.activeSessionId).toBe("s1")
    expect(store.messages).toHaveLength(1)
  })

  it("re-syncs when chat comes back with the same session", async () => {
    navigate("chat", "s1")
    mountController()
    await settle()
    navigate("track")
    await settle()

    store.openSession.mockClear()
    navigate("chat", "s1")
    await settle()

    // The store's own guard makes the re-open a no-op, but the sync has to
    // run — that is what re-anchors the scroll and reveals the scroller.
    expect(store.activeSessionId).toBe("s1")
    expect(store.startNewSession).not.toHaveBeenCalled()
  })

  it("still clears the session when the chat tab opens the bare root", async () => {
    navigate("chat", "s1")
    mountController()
    await settle()
    navigate("home")
    await settle()

    // The tab button deliberately always lands on `/tabs/chat` with no query;
    // the session is SUPPOSED to disappear there.
    navigate("chat")
    await settle()

    expect(store.startNewSession).toHaveBeenCalled()
    expect(store.activeSessionId).toBeNull()
    expect(store.messages).toHaveLength(0)
  })

  it("opens a session carried in on a deep link", async () => {
    mountController()
    await settle()

    navigate("chat", "s2")
    await settle()

    expect(store.openSession).toHaveBeenCalledWith("s2")
    expect(pauseGroup).toHaveBeenCalledWith("inline")
  })

  it("does not rewrite the route when Ask Sadhu mints a session off chat", async () => {
    mountController()
    await settle()

    // The transcript dialog is open over the track page: the store gets an
    // active session several awaits before the handler navigates.
    navigate("track")
    await settle()
    replace.mockClear()
    store.activeSessionId = "s3"
    await settle()

    expect(replace).not.toHaveBeenCalled()
  })

  it("promotes the URL when a session is minted while on chat", async () => {
    mountController()
    await settle()

    replace.mockClear()
    store.activeSessionId = "s4"
    await settle()

    expect(replace).toHaveBeenCalledWith({ name: "chat", query: { session: "s4" } })
  })

  it("keeps the user-initiated replaces working", async () => {
    navigate("chat", "s1")
    const api = mountController()
    await settle()

    replace.mockClear()
    api.onNewSession()
    await settle()

    expect(replace).toHaveBeenCalledWith({ name: "chat", query: {} })
  })
})

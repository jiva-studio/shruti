// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, reactive } from "vue"
import type { ChatFocusPayload } from "@lib/domain/chatMessage.js"
import type { ChatMessage } from "@lectorium/stores/chat/chatTypes.js"

/* -- Module doubles ----------------------------------------------------- */

const route = reactive<{ name: string; query: Record<string, string> }>({
  name: "chat",
  query: {},
})

vi.mock("vue-router", () => ({ useRoute: () => route }))
vi.mock("@lectorium/router/index.js", () => ({
  default: { currentRoute: { value: route }, replace: vi.fn(), push: vi.fn() },
}))

interface SentMessage {
  readonly text: string
  readonly opts?: { focus?: Record<string, unknown> }
}

const sent: SentMessage[] = []
const retried: string[] = []
let cancelled = 0
let recentListening: unknown[] = []
let listRecentFails = false

const player = reactive({ open: false, trackId: null as string | null })

const store = reactive({
  messages: [] as ChatMessage[],
  sessions: [] as unknown[],
  activeSessionId: null as string | null,
  sending: false,
  unseenProactiveSessionIds: new Set<string>(),
  loadingFocusIds: new Set<string>(),
  inputFocusToken: 0,
  isComposeBlocked: false,
  composeBlockedUntil: null as number | null,
  chatUsage: null as { current: number; limit: number; resetsAtEpoch: number } | null,
  searchSessions: () => [],
  refreshSessions: async () => undefined,
  getLastSeenMessageId: async () => null,
  markSessionSeen: async () => undefined,
  openSession: async () => undefined,
  startNewSession: () => {
    store.activeSessionId = null
    store.messages = []
  },
  sendMessage: async (text: string, opts?: SentMessage["opts"]) => void sent.push({ text, opts }),
  cancelStream: () => void (cancelled += 1),
  retryLast: async (id: string) => void retried.push(id),
})

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}|${params.from}|${params.to}|${params.title}` : key,
  }),
}))
vi.mock("@ionic/vue", () => ({ alertController: { create: vi.fn() } }))
vi.mock("@lectorium/stores/useChatStore.js", () => ({ useChatStore: () => store }))
vi.mock("@lectorium/stores/usePlayerStore.js", () => ({ usePlayerStore: () => player }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ info: vi.fn(), error: vi.fn(), show: vi.fn(), success: vi.fn() }),
}))
vi.mock("@lectorium/composables/useTrackUserState.js", () => ({
  useTrackUserState: () => ({
    listRecent: async () => {
      if (listRecentFails) throw new Error("user db is locked")
      return recentListening
    },
  }),
}))
vi.mock("@lib/chat/audio/useAudioOrchestrator.js", () => ({ pauseGroup: vi.fn() }))
vi.mock("@lectorium/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))

const { useChatController } = await import("../ChatView.controller.js")

/* -- Fixtures ----------------------------------------------------------- */

function focus(over: Partial<ChatFocusPayload> = {}): ChatFocusPayload {
  return {
    trackId: "t1",
    startMs: 0,
    endMs: 1000,
    text: "the quoted passage",
    ...over,
  }
}

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content: "answer",
    createdAt: 1_700_000_000_000,
    ...over,
  }
}

/* -- Harness ------------------------------------------------------------ */

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

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

beforeEach(() => {
  sent.length = 0
  retried.length = 0
  cancelled = 0
  recentListening = []
  listRecentFails = false
  store.messages = []
  store.activeSessionId = null
  store.sending = false
  store.chatUsage = null
  store.isComposeBlocked = false
  store.composeBlockedUntil = null
  player.open = false
  player.trackId = null
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe("sending a turn", () => {
  it("dispatches the composer's text as it stands", async () => {
    const api = mountController()
    await api.onSend("what is bhakti")
    expect(sent).toEqual([{ text: "what is bhakti", opts: undefined }])
  })

  it("starts a fresh session for a suggestion pill, so the prompt never lands in the input", async () => {
    store.activeSessionId = "s-old"
    const api = mountController()

    await api.onPickSuggestion("recap my last lecture")
    await settle()

    // The old session is left behind and the prompt goes out once, as a turn
    // of the new one — never as text parked in the composer.
    expect(store.activeSessionId).toBeNull()
    expect(sent.map((m) => m.text)).toEqual(["recap my last lecture"])
  })

  it("stops the streaming turn on demand", () => {
    const api = mountController()
    api.onCancel()
    expect(cancelled).toBe(1)
  })

  it("retries the message the user pointed at", async () => {
    const api = mountController()
    await api.onRetry("m7")
    expect(retried).toEqual(["m7"])
  })
})

describe("recapping an outline chapter", () => {
  it("bounds the window with the next chapter's start", async () => {
    const api = mountController()

    await api.onPickChapter({
      trackId: "t1",
      item: { startMs: 60_000, title: "On surrender" },
      nextItem: { startMs: 180_000, title: "On service" },
    })

    expect(sent).toEqual([
      {
        text: "chat.outlineRecapPrompt|01:00|03:00|On surrender",
        opts: {
          focus: { track_id: "t1", start_ms: 60_000, end_ms: 180_000, title: "On surrender" },
        },
      },
    ])
  })

  it("gives the last chapter a five-minute window of its own", async () => {
    const api = mountController()

    await api.onPickChapter({
      trackId: "t1",
      item: { startMs: 3_600_000, title: "Closing words" },
      nextItem: null,
    })

    expect(sent[0]!.opts?.focus).toMatchObject({ start_ms: 3_600_000, end_ms: 3_900_000 })
    expect(sent[0]!.text).toBe("chat.outlineRecapPrompt|1:00:00|1:05:00|Closing words")
  })

  it("never asks for a window that ends before it starts", async () => {
    const api = mountController()

    // A malformed outline whose next chapter starts before this one.
    await api.onPickChapter({
      trackId: "t1",
      item: { startMs: 120_000, title: "On surrender" },
      nextItem: { startMs: 60_000, title: "Out of order" },
    })

    expect(sent[0]!.opts?.focus).toMatchObject({ start_ms: 120_000, end_ms: 121_000 })
  })
})

describe("the bibliographic header", () => {
  it("takes its identity from the first focused message of the session", async () => {
    store.messages = [
      message({ id: "m0", role: "user", content: "question" }),
      message({
        id: "m1",
        focus: focus({
          trackTitle: "Вечерняя лекция",
          authorName: "Test Speaker",
          date: "1996-03-14",
          location: "Bhubaneswar",
        }),
      }),
      message({ id: "m2", focus: focus({ trackTitle: "A later focus" }) }),
    ]
    const api = mountController()

    expect(api.sessionHeader.value).toEqual({
      title: "Вечерняя лекция",
      authorName: "Test Speaker",
      date: "1996-03-14",
      location: "Bhubaneswar",
    })
  })

  it("leaves the fields the focus does not carry empty rather than undefined", async () => {
    store.messages = [message({ focus: focus({ trackTitle: "Вечерняя лекция" }) })]
    const api = mountController()

    expect(api.sessionHeader.value).toEqual({
      title: "Вечерняя лекция",
      authorName: null,
      date: null,
      location: null,
    })
  })

  it("is absent for a free-form chat", () => {
    store.messages = [message({ role: "user", content: "question" })]
    expect(mountController().sessionHeader.value).toBeNull()
  })
})

describe("what the empty state may offer", () => {
  it("offers the recap chip once the device has a listening row", async () => {
    recentListening = [{ trackId: "t1" }]
    const api = mountController()
    await settle()
    expect(api.hasRecentListening.value).toBe(true)
  })

  it("offers nothing when nothing has been listened to", async () => {
    const api = mountController()
    await settle()
    expect(api.hasRecentListening.value).toBe(false)
  })

  it("offers nothing when the user DB cannot be read", async () => {
    listRecentFails = true
    const api = mountController()
    await settle()
    expect(api.hasRecentListening.value).toBe(false)
  })
})

describe("what the composer is told about the player and the quota", () => {
  it("reports a current track only while the player is open on one", async () => {
    const api = mountController()
    expect(api.hasCurrentTrack.value).toBe(false)

    player.trackId = "t1"
    await nextTick()
    expect(api.hasCurrentTrack.value).toBe(false)

    player.open = true
    await nextTick()
    expect(api.hasCurrentTrack.value).toBe(true)
  })

  it("passes the quota block and its deadline straight through", async () => {
    const api = mountController()
    expect(api.isComposeBlocked.value).toBe(false)

    store.isComposeBlocked = true
    store.composeBlockedUntil = 1_700_000_100_000
    store.chatUsage = { current: 20, limit: 20, resetsAtEpoch: 1_700_000_100 }
    await nextTick()

    expect(api.isComposeBlocked.value).toBe(true)
    expect(api.composeBlockedUntil.value).toBe(1_700_000_100_000)
    expect(api.chatUsage.value).toEqual({ current: 20, limit: 20, resetsAtEpoch: 1_700_000_100 })
  })

  it("hands the view a copy of the message list, not the store's own array", async () => {
    store.messages = [message()]
    const api = mountController()

    expect(api.hasMessages.value).toBe(true)
    expect(api.messages.value).not.toBe(store.messages)
    expect(api.messages.value.map((m) => m.id)).toEqual(["m1"])
  })
})

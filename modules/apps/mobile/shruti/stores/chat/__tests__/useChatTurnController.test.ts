import { beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"
import type { RunChatTurnEvent } from "@usecases"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import { BackendUnavailableError } from "@lib/domain/chatMessage.js"
import type { ChatMessage, ChatSession } from "@usecases/chat/chatThread.js"
import type { ChatTurnControllerDeps } from "../useChatTurnController.js"

const turn = vi.hoisted(() => ({
  events: [] as unknown[],
  throwAfter: null as Error | null,
  inputs: [] as { isFirstAssistantTurn: boolean }[],
  started: [] as unknown[],
  settled: [] as unknown[],
}))

vi.mock("@usecases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@usecases")>()),
  runChatTurn: async function* (input: { isFirstAssistantTurn: boolean }) {
    turn.inputs.push(input)
    for (const event of turn.events) yield event
    if (turn.throwAfter) throw turn.throwAfter
  },
}))
vi.mock("@ionic/vue", () => ({ toastController: { create: vi.fn() } }))
vi.mock("@shruti/stores/useAuthStore.js", () => ({
  useAuthStore: () => ({ ensureFresh: async () => undefined }),
}))
vi.mock("@shruti/composables/useDailyReminder.js", () => ({ applyDailyReminder: vi.fn() }))
vi.mock("@shruti/chat/turnNotificationEvents.js", () => ({
  emitTurnStarted: (e: unknown) => void turn.started.push(e),
  emitTurnSettled: (e: unknown) => void turn.settled.push(e),
}))

const { useChatTurnController } = await import("../useChatTurnController.js")

const NOW = Date.parse("2026-05-17T16:42:00Z")
const SESSION = "s-1" as ChatSessionId
const ASSISTANT = "a-1" as ChatMessageId

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

const USER: RunChatTurnEvent = {
  kind: "user-message",
  message: message("u-1", { role: "user", content: "hi" }),
}
const PLACEHOLDER: RunChatTurnEvent = { kind: "assistant-placeholder", messageId: ASSISTANT }

function harness(opts: { messages?: ChatMessage[]; blocked?: boolean; noSession?: boolean } = {}) {
  const messages = ref<ChatMessage[]>(opts.messages ?? [])
  const sending = ref(false)
  const sessions = ref<ChatSession[]>([{ id: SESSION, title: "T", createdAt: NOW, updatedAt: NOW }])
  const activeSessionId = ref<string | null>(SESSION)
  const removePending = vi.fn<(id: string) => Promise<void>>(async () => undefined)
  const addPending = vi.fn<(id: string, sessionId: string) => Promise<void>>(async () => undefined)
  const moveSessionToTop = vi.fn()
  const toastError = vi.fn()
  const deps = {
    messages,
    sending,
    sessions,
    activeSessionId,
    chat: {
      threads: () => ({ sessions: {}, messages: {}, now: () => NOW }),
      proactiveState: () => ({}),
    },
    streams: { turnControllers: new Map(), liveTargets: new Map() },
    compose: {
      usage: {
        snapshot: ref(null),
        hydrate: async () => undefined,
        record: () => undefined,
        recordFromRateLimit: () => undefined,
      },
      composeLock: {
        composeBlockedUntil: ref<number | null>(null),
        isComposeBlocked: computed(() => opts.blocked ?? false),
        applyRateLimit: () => undefined,
        resetComposeLock: () => undefined,
      },
    },
    threads: {
      list: {
        sessionTitleFor: () => "T",
        moveSessionToTop,
        ensureActiveSession: async () => {
          if (opts.noSession) throw new Error("insert failed")
          return SESSION
        },
      },
    },
    readPending: async () => [],
    addPending,
    removePending,
    services: {
      stream: () => ({}),
      title: () => ({}),
      questions: () => ({}),
      feedback: () => ({}),
      resume: () => ({}),
    },
    notifications: {},
    buildUserContext: async () => ({}),
    addToQueue: async () => ({ ok: true }),
    addToLibrary: async () => ({ ok: true }),
    lang: () => "en",
    translateCitations: () => false,
    toastError,
    t: (key: string) => key,
  } as unknown as ChatTurnControllerDeps
  const controller = useChatTurnController(deps)
  return { controller, messages, sending, removePending, addPending, moveSessionToTop, toastError }
}

beforeEach(() => {
  turn.events = []
  turn.throwAfter = null
  turn.inputs = []
  turn.started = []
  turn.settled = []
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

describe("useChatTurnController — one turn end to end", () => {
  it("folds placeholder, delta and finalised into one final assistant message", async () => {
    const final = message(ASSISTANT, { content: "Hello there" })
    turn.events = [
      USER,
      PLACEHOLDER,
      { kind: "delta", text: "Hello" },
      { kind: "delta", text: " there" },
      { kind: "finalised", message: final },
    ] satisfies RunChatTurnEvent[]
    const h = harness()

    await h.controller.sendMessage("  hi  ")

    const assistants = h.messages.value.filter((m) => m.role === "assistant")
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ id: ASSISTANT, content: "Hello there" })
    expect(assistants[0]!.streaming).toBeFalsy()
    expect(h.messages.value.map((m) => m.id)).toEqual(["u-1", ASSISTANT])
    expect(h.addPending).toHaveBeenCalledWith(ASSISTANT, SESSION)
    expect(h.removePending).toHaveBeenCalledTimes(1)
    expect(h.removePending).toHaveBeenCalledWith(ASSISTANT)
    expect(h.sending.value).toBe(false)
    expect(h.moveSessionToTop).toHaveBeenCalledWith(SESSION, expect.any(Number))
    expect(turn.started).toEqual([{ assistantMessageId: ASSISTANT, sessionId: SESSION }])
    expect(turn.settled).toEqual([{ assistantMessageId: ASSISTANT, sessionId: SESSION, ok: true }])
  })

  it("settles a failed turn once, as not ok", async () => {
    turn.events = [
      USER,
      PLACEHOLDER,
      { kind: "error", code: "server_error", message: "boom" },
    ] satisfies RunChatTurnEvent[]
    const h = harness()

    await h.controller.sendMessage("hi")

    expect(h.removePending).toHaveBeenCalledOnce()
    expect(h.removePending).toHaveBeenCalledWith(ASSISTANT)
    expect(turn.settled).toEqual([{ assistantMessageId: ASSISTANT, sessionId: SESSION, ok: false }])
  })

  it("leaves a turn whose socket dropped to the resume poll", async () => {
    turn.events = [
      USER,
      PLACEHOLDER,
      { kind: "error", code: "stream", message: "socket closed" },
    ] satisfies RunChatTurnEvent[]
    const h = harness()

    await h.controller.sendMessage("hi")

    expect(h.removePending).not.toHaveBeenCalled()
    expect(turn.settled).toEqual([])
  })

  it("leaves a finalised answer truncated by the stream to the resume poll", async () => {
    const truncated = message(ASSISTANT, {
      content: "Hel",
      error: { kind: "truncated", reason: "stream" },
    } as Partial<ChatMessage>)
    turn.events = [USER, PLACEHOLDER, { kind: "finalised", message: truncated }]
    const h = harness()

    await h.controller.sendMessage("hi")

    expect(h.removePending).not.toHaveBeenCalled()
    expect(turn.settled).toEqual([])
  })
})

describe("useChatTurnController — what a send refuses", () => {
  it.each<[string, { text: string; blocked?: boolean }]>([
    ["a blank question", { text: "   " }],
    ["while the compose lock holds", { text: "hi", blocked: true }],
  ])("sends nothing for %s", async (_, c) => {
    const h = harness({ blocked: c.blocked })

    await h.controller.sendMessage(c.text)

    expect(turn.inputs).toEqual([])
    expect(h.sending.value).toBe(false)
  })

  it("sends nothing while a turn is already in flight", async () => {
    const h = harness()
    h.sending.value = true

    await h.controller.sendMessage("hi")

    expect(turn.inputs).toEqual([])
  })

  it("releases the compose state when the session cannot be opened", async () => {
    const h = harness({ noSession: true })

    await h.controller.sendMessage("hi")

    expect(h.sending.value).toBe(false)
    expect(h.toastError).toHaveBeenCalledWith("chat.errUnknown")
    expect(turn.inputs).toEqual([])
  })
})

describe("useChatTurnController — first assistant turn", () => {
  it("is first while only a streaming assistant bubble is on screen", async () => {
    const h = harness({ messages: [message("a-0", { streaming: true })] })
    await h.controller.sendMessage("hi")
    expect(turn.inputs[0]!.isFirstAssistantTurn).toBe(true)
  })

  it("is not first once a settled answer exists", async () => {
    const h = harness({ messages: [message("u-0", { role: "user" }), message("a-0")] })
    await h.controller.sendMessage("hi")
    expect(turn.inputs[0]!.isFirstAssistantTurn).toBe(false)
  })
})

describe("useChatTurnController — a step that throws", () => {
  it("drops the placeholder and toasts when the backend is unavailable", async () => {
    turn.events = [USER, PLACEHOLDER]
    turn.throwAfter = new BackendUnavailableError()
    const h = harness()

    await h.controller.sendMessage("hi")

    expect(h.messages.value.map((m) => m.id)).toEqual(["u-1"])
    expect(h.toastError).toHaveBeenCalledWith(
      "chat.error.backendUnavailable.title: chat.error.backendUnavailable.body"
    )
  })

  it("turns the placeholder into a failed bubble on any other error", async () => {
    turn.events = [USER, PLACEHOLDER]
    turn.throwAfter = new Error("fold broke")
    const h = harness()

    await h.controller.sendMessage("hi")

    const bubble = h.messages.value.find((m) => m.id === ASSISTANT)
    expect(bubble?.streaming).toBeFalsy()
    expect(bubble?.error).toBeTruthy()
    expect(h.removePending).toHaveBeenCalledOnce()
  })
})

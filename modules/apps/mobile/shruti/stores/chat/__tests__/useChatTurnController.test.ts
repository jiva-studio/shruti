import { describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"
import type { RunChatTurnEvent } from "@usecases"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ChatMessage, ChatSession } from "@usecases/chat/chatThread.js"
import type { ChatTurnControllerDeps } from "../useChatTurnController.js"

const turn = vi.hoisted(() => ({ events: [] as unknown[] }))

vi.mock("@usecases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@usecases")>()),
  runChatTurn: async function* () {
    for (const event of turn.events) yield event
  },
}))
vi.mock("@ionic/vue", () => ({ toastController: { create: vi.fn() } }))
vi.mock("@shruti/stores/useAuthStore.js", () => ({
  useAuthStore: () => ({ ensureFresh: async () => undefined }),
}))
vi.mock("@shruti/composables/useDailyReminder.js", () => ({ applyDailyReminder: vi.fn() }))
vi.mock("@shruti/chat/turnNotificationEvents.js", () => ({
  emitTurnStarted: vi.fn(),
  emitTurnSettled: vi.fn(),
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

function harness() {
  const messages = ref<ChatMessage[]>([])
  const sending = ref(false)
  const sessions = ref<ChatSession[]>([{ id: SESSION, title: "T", createdAt: NOW, updatedAt: NOW }])
  const activeSessionId = ref<string | null>(SESSION)
  const removePending = vi.fn<(id: string) => Promise<void>>(async () => undefined)
  const addPending = vi.fn<(id: string, sessionId: string) => Promise<void>>(async () => undefined)
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
        isComposeBlocked: computed(() => false),
        applyRateLimit: () => undefined,
        resetComposeLock: () => undefined,
      },
    },
    threads: {
      list: {
        sessionTitleFor: () => "T",
        moveSessionToTop: () => undefined,
        ensureActiveSession: async () => SESSION,
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
    toastError: vi.fn(),
    t: (key: string) => key,
  } as unknown as ChatTurnControllerDeps
  return { deps, messages, sending, removePending, addPending }
}

describe("useChatTurnController — one turn end to end", () => {
  it("folds placeholder, delta and finalised into one final assistant message", async () => {
    const final = message(ASSISTANT, { content: "Hello there" })
    turn.events = [
      { kind: "user-message", message: message("u-1", { role: "user", content: "hi" }) },
      { kind: "assistant-placeholder", messageId: ASSISTANT },
      { kind: "delta", text: "Hello" },
      { kind: "delta", text: " there" },
      { kind: "finalised", message: final },
    ] satisfies RunChatTurnEvent[]
    const h = harness()
    const controller = useChatTurnController(h.deps)

    await controller.sendMessage("hi")

    const assistants = h.messages.value.filter((m) => m.role === "assistant")
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ id: ASSISTANT, content: "Hello there" })
    expect(assistants[0]!.streaming).toBeFalsy()
    expect(h.messages.value.map((m) => m.id)).toEqual(["u-1", ASSISTANT])
    expect(h.addPending).toHaveBeenCalledWith(ASSISTANT, SESSION)
    expect(h.removePending).toHaveBeenCalledTimes(1)
    expect(h.removePending).toHaveBeenCalledWith(ASSISTANT)
    expect(h.sending.value).toBe(false)
  })
})

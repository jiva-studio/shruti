// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, reactive, ref } from "vue"
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"

/* -- Module doubles ---------------------------------------------------- */

const state = vi.hoisted(() => ({
  chat: { sending: false },
  auth: { isPro: false },
  requestOpen: (() => {}) as (reason: string) => void,
  triggerSignIn: async (): Promise<void> => {},
}))

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    // Identity `t` — assertions read i18n KEYS, which is what the
    // notice classification actually decides.
    t: (key: string) => key,
    te: () => true,
    tm: () => [],
  }),
}))
vi.mock("@ionic/vue", () => ({
  IonSpinner: defineComponent({ setup: () => () => h("span") }),
}))
vi.mock("@lectorium/stores/useChatStore.js", () => ({ useChatStore: () => state.chat }))
vi.mock("@lectorium/stores/useAuthStore.js", () => ({ useAuthStore: () => state.auth }))
vi.mock("@lectorium/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen: state.requestOpen }),
}))
vi.mock("@lectorium/composables/useAnonymousSignInFlow.js", () => ({
  useAnonymousSignInFlow: () => ({ triggerSignIn: state.triggerSignIn, busy: ref(false) }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@lectorium/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))
vi.mock("../../composables/useChatExportMarkdown.js", () => ({
  useChatExportMarkdown: () => ({ exportMarkdown: ref(""), citeTrackIds: ref([]) }),
}))

const stub = (name: string) => defineComponent({ name, setup: () => () => h("div") })
vi.mock("../ChatTokenRenderer.vue", () => ({ default: stub("ChatTokenRenderer") }))
vi.mock("../ChatMessageActions.vue", () => ({ default: stub("ChatMessageActions") }))
vi.mock("../CitationCardContainer.vue", () => ({ default: stub("CitationCardContainer") }))
vi.mock("../ChatChips.vue", () => ({ default: stub("ChatChips") }))
vi.mock("@lib/ui/chat/StatusPill.vue", () => ({ default: stub("StatusPill") }))

// Imported after the mocks so the whole bubble subtree resolves to them.
const { default: ChatMessageList } = await import("../ChatMessageList.vue")

/* -- Fixtures ---------------------------------------------------------- */

let seq = 0
function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1
  return {
    id: `m${seq}`,
    sessionId: "s1",
    role: "assistant",
    content: "hello",
    createdAt: 1_700_000_000_000,
    ...over,
  } as ChatMessage
}

function failed(code: string, retryAfterAt?: number): ChatMessage {
  return msg({ content: "", error: { kind: "failed", code, retryAfterAt } })
}

/* -- Harness ----------------------------------------------------------- */

let added: string[] = []
let removed: string[] = []

function spyOnConnectivityListeners(): void {
  const origAdd = window.addEventListener.bind(window)
  const origRemove = window.removeEventListener.bind(window)
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "online" || type === "offline") added.push(type)
    origAdd(type, listener as EventListener, options)
  })
  vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "online" || type === "offline") removed.push(type)
    origRemove(type, listener as EventListener, options)
  })
}

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true })
}

function mountList(messages: ChatMessage[]): {
  root: HTMLElement
  retried: string[]
  unmount: () => void
} {
  const retried: string[] = []
  const items = reactive(messages)
  const Host = defineComponent({
    setup() {
      return () =>
        h(ChatMessageList, {
          messages: items as unknown as readonly ChatMessage[],
          onRetry: (id: string) => retried.push(id),
        })
    },
  })
  const app = createApp(Host)
  const root = document.createElement("div")
  document.body.appendChild(root)
  app.mount(root)
  return {
    root,
    retried,
    unmount: () => {
      app.unmount()
      root.remove()
    },
  }
}

function noticeButton(root: HTMLElement): HTMLButtonElement | null {
  return root.querySelector(".inline-notice .btn")
}

describe("chat message list — status machinery cost", () => {
  beforeEach(() => {
    added = []
    removed = []
    state.chat.sending = false
    state.auth.isPro = false
    setOnLine(true)
    spyOnConnectivityListeners()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("registers no connectivity listeners for a thread of ordinary bubbles", () => {
    const messages = Array.from({ length: 60 }, (_, i) =>
      msg({ role: i % 2 === 0 ? "user" : "assistant" })
    )
    const list = mountList(messages)
    expect(added).toEqual([])
    list.unmount()
  })

  it("registers a constant listener count regardless of how many bubbles failed", () => {
    const one = mountList([failed("agent_error")])
    const afterOne = [...added]
    one.unmount()

    added = []
    const many = mountList([
      ...Array.from({ length: 40 }, () => msg()),
      failed("agent_error"),
      failed("network"),
      failed("rate_limited"),
    ])
    expect(added).toEqual(afterOne)
    expect(added.filter((t) => t === "online")).toHaveLength(1)
    expect(added.filter((t) => t === "offline")).toHaveLength(1)
    many.unmount()
  })

  it("cleans up the listeners when the list unmounts", () => {
    const list = mountList([msg(), failed("network")])
    expect(added).toHaveLength(2)
    list.unmount()
    expect(removed.filter((t) => t === "online")).toHaveLength(1)
    expect(removed.filter((t) => t === "offline")).toHaveLength(1)
  })
})

describe("chat message list — status behaviour", () => {
  beforeEach(() => {
    added = []
    removed = []
    state.chat.sending = false
    state.auth.isPro = false
    setOnLine(true)
  })

  it("renders the offline notice and auto-retries the last bubble on reconnect", async () => {
    setOnLine(false)
    const list = mountList([msg({ role: "user" }), failed("network")])
    await nextTick()

    expect(list.root.querySelector(".inline-notice")?.className).toContain("info")
    expect(list.root.querySelector(".inline-notice .body")?.textContent).toBe(
      "chat.errOffline.body"
    )
    expect(noticeButton(list.root)?.textContent?.trim()).toBe("chat.errOffline.cta")
    // Still offline → the CTA is inert.
    expect(noticeButton(list.root)?.disabled).toBe(true)

    setOnLine(true)
    window.dispatchEvent(new Event("online"))
    await nextTick()

    expect(list.retried).toHaveLength(1)
    expect(noticeButton(list.root)?.disabled).toBe(false)
    list.unmount()
  })

  it("does not auto-retry a failed bubble that is no longer last", async () => {
    setOnLine(false)
    const list = mountList([failed("network"), msg({ role: "user" })])
    await nextTick()

    setOnLine(true)
    window.dispatchEvent(new Event("online"))
    await nextTick()

    expect(list.retried).toEqual([])
    list.unmount()
  })

  it("does not auto-retry a non-network failure", async () => {
    const list = mountList([failed("agent_error")])
    await nextTick()
    window.dispatchEvent(new Event("online"))
    await nextTick()
    expect(list.retried).toEqual([])
    list.unmount()
  })

  it("keeps the retry CTA disabled until the retry deadline passes", async () => {
    const future = mountList([failed("agent_error", Date.now() + 60_000)])
    await nextTick()
    expect(noticeButton(future.root)?.disabled).toBe(true)
    future.unmount()

    const past = mountList([failed("agent_error", Date.now() - 1_000)])
    await nextTick()
    expect(noticeButton(past.root)?.disabled).toBe(false)
    past.unmount()
  })

  it("offers the sign-in CTA to an anonymous user over quota", async () => {
    const list = mountList([
      msg({ content: "", error: { kind: "failed", code: "rate_limited", tier: "anonymous" } }),
    ])
    await nextTick()
    expect(noticeButton(list.root)?.textContent?.trim()).toBe("chat.signInForMoreCta")
    list.unmount()
  })

  it("renders the truncated suffix on a truncated bubble and no notice", async () => {
    const list = mountList([msg({ error: { kind: "truncated", reason: "turns" } })])
    await nextTick()
    expect(list.root.querySelector(".inline-notice")).toBeNull()
    expect(list.root.querySelector(".truncated-suffix")?.textContent).toBe("chat.errTruncatedTurns")
    list.unmount()
  })

  it("blocks retry while the store is sending", async () => {
    state.chat.sending = true
    const list = mountList([failed("agent_error")])
    await nextTick()
    noticeButton(list.root)?.click()
    expect(list.retried).toEqual([])
    list.unmount()
  })

  it("retries on tap when the store is idle", async () => {
    const list = mountList([failed("agent_error")])
    await nextTick()
    noticeButton(list.root)?.click()
    expect(list.retried).toHaveLength(1)
    list.unmount()
  })
})

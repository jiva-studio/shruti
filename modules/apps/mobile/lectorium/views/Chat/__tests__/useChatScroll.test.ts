// @vitest-environment jsdom
/**
 * The scroll rule behind the chat list: a question the user just sent is
 * pinned to the top of the viewport and the answer streams in below it, never
 * chasing the reader downward.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, type App } from "vue"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"

const holder = vi.hoisted(() => ({ store: { messages: [] as ChatMessage[] } }))

vi.mock("@lectorium/stores/useChatStore.js", async () => {
  const { reactive } = await import("vue")
  holder.store = reactive({ messages: [] as ChatMessage[] })
  return { useChatStore: () => holder.store }
})

// jsdom ships no `CSS` namespace; the lookup quotes the id through it.
vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/["\\]/g, "\\$&") })

const { useChatScroll } = await import("../useChatScroll.js")

/* -- Fixtures ----------------------------------------------------------- */

function message(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: "s-1" as ChatSessionId,
    role: "user",
    content: "Who am I?",
    createdAt: 1_700_000_000_000,
    ...over,
  }
}

/* -- Harness ------------------------------------------------------------ */

const scrolledTo: { id: string; behavior?: ScrollBehavior }[] = []

let app: App | null = null

interface Mounted {
  readonly scroll: ReturnType<typeof useChatScroll>
  readonly content: HTMLElement
}

/** A scroller holding one row per message, each answering to its message id. */
function mountScroll(ids: string[], host?: HTMLElement): Mounted {
  const content = document.createElement("div")
  for (const id of ids) {
    const row = document.createElement("div")
    row.setAttribute("data-message-id", id)
    row.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      scrolledTo.push({
        id,
        behavior: typeof options === "object" ? options.behavior : undefined,
      })
    }
    content.appendChild(row)
  }
  ;(host ?? document.body).appendChild(content)

  let scroll!: ReturnType<typeof useChatScroll>
  app = createApp({
    setup() {
      scroll = useChatScroll()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  scroll.contentRef.value = content
  return { scroll, content }
}

/** Two ticks plus a frame — what `pinLastQuestion` waits for. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await Promise.resolve()
}

beforeEach(() => {
  holder.store.messages = []
  scrolledTo.length = 0
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

/* -- Cases -------------------------------------------------------------- */

describe("useChatScroll, pinning the question", () => {
  it("pins a question the moment it is sent", async () => {
    const { scroll } = mountScroll(["m-1"])
    holder.store.messages = [message("m-1")]
    await settle()

    expect(scrolledTo).toEqual([{ id: "m-1", behavior: "smooth" }])
    expect(scroll.contentRef.value).not.toBeNull()
  })

  it("keeps that question pinned while the answer streams in below", async () => {
    mountScroll(["m-1", "m-2"])
    holder.store.messages = [message("m-1")]
    await settle()

    holder.store.messages = [
      message("m-1"),
      message("m-2", { role: "assistant", content: "", streaming: true }),
    ]
    await settle()

    expect(scrolledTo.map((s) => s.id)).toEqual(["m-1", "m-1"])
  })

  it("does not yank the reader back on every streamed delta", async () => {
    mountScroll(["m-1", "m-2"])
    holder.store.messages = [
      message("m-1"),
      message("m-2", { role: "assistant", content: "The", streaming: true }),
    ]
    await settle()
    scrolledTo.length = 0

    holder.store.messages = [
      message("m-1"),
      message("m-2", { role: "assistant", content: "The soul", streaming: true }),
    ]
    await settle()

    expect(scrolledTo).toEqual([])
  })

  it("leaves the reader where they are when the answer finishes", async () => {
    mountScroll(["m-1", "m-2"])
    holder.store.messages = [
      message("m-1"),
      message("m-2", { role: "assistant", content: "The soul", streaming: true }),
    ]
    await settle()
    scrolledTo.length = 0

    holder.store.messages = [
      message("m-1"),
      message("m-2", { role: "assistant", content: "The soul is eternal.", streaming: false }),
    ]
    await settle()

    expect(scrolledTo).toEqual([])
  })

  it("scrolls nowhere when a history load lands a finished answer last", async () => {
    mountScroll(["m-1", "m-2"])
    holder.store.messages = [
      message("m-1"),
      message("m-2", { role: "assistant", content: "The soul is eternal." }),
    ]
    await settle()

    expect(scrolledTo).toEqual([])
  })

  it("survives a streaming placeholder with no question before it", async () => {
    mountScroll(["m-1"])
    holder.store.messages = [message("m-1", { role: "assistant", content: "", streaming: true })]
    await settle()

    expect(scrolledTo).toEqual([])
  })

  it("ignores a session that was emptied", async () => {
    mountScroll(["m-1"])
    holder.store.messages = [message("m-1")]
    await settle()
    scrolledTo.length = 0

    holder.store.messages = []
    await settle()

    expect(scrolledTo).toEqual([])
  })
})

describe("useChatScroll, scrolling on demand", () => {
  it("pins nothing before the list is on screen", () => {
    let scroll!: ReturnType<typeof useChatScroll>
    app = createApp({
      setup() {
        scroll = useChatScroll()
        return () => null
      },
    })
    app.mount(document.createElement("div"))

    scroll.scrollMessageToTop("m-1")
    expect(scrolledTo).toEqual([])
  })

  it("jumps to the message asked for, without animating when told not to", () => {
    const { scroll } = mountScroll(["m-1", "m-2"])

    scroll.scrollMessageToTop("m-2", "auto")

    expect(scrolledTo).toEqual([{ id: "m-2", behavior: "auto" }])
  })

  it("stays put when the message is no longer in the list", () => {
    const { scroll } = mountScroll(["m-1"])

    scroll.scrollMessageToTop("m-gone")

    expect(scrolledTo).toEqual([])
  })

  it("hands the bottom scroll to Ionic when the list sits inside its content", async () => {
    const ionContent = document.createElement("ion-content")
    const durations: number[] = []
    Object.assign(ionContent, {
      scrollToBottom: async (durationMs: number) => void durations.push(durationMs),
    })
    document.body.appendChild(ionContent)
    const { scroll } = mountScroll(["m-1"], ionContent)

    await scroll.scrollToBottom(300)

    expect(durations).toEqual([300])
  })

  it("scrolls the element itself when there is no Ionic content around it", async () => {
    const { scroll, content } = mountScroll(["m-1"])
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 4200 })

    await scroll.scrollToBottom()

    expect(content.scrollTop).toBe(4200)
  })

  it("does not reach for the bottom before the list is on screen", async () => {
    let scroll!: ReturnType<typeof useChatScroll>
    app = createApp({
      setup() {
        scroll = useChatScroll()
        return () => null
      },
    })
    app.mount(document.createElement("div"))

    await expect(scroll.scrollToBottom()).resolves.toBeUndefined()
  })
})

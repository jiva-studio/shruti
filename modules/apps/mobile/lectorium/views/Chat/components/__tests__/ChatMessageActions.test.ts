// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"
import type { ChatMessageId } from "@lib/domain/core.js"

/* -- Module doubles ----------------------------------------------------- */

interface FeedbackCall {
  readonly messageId: string
  readonly state: string
  readonly category?: string
  readonly comment?: string
}

const copied: string[] = []
const sharedTexts: string[] = []
const feedback: FeedbackCall[] = []
const toasts: { level: string; text: string }[] = []

let feedbackFails = false
let gateFeedback = false
let releaseFeedback: ((value: void) => void) | null = null

const icon = (name: string) => defineComponent({ name, setup: () => () => h("span") })

/** Exposes the sheet's own state and both of its outcomes as real DOM. */
const FeedbackSheetStub = defineComponent({
  name: "FeedbackSheet",
  props: { open: Boolean, submitting: Boolean },
  emits: ["submit", "cancel"],
  setup:
    (props, { emit }) =>
    () =>
      props.open
        ? h("div", { class: "sheet", "data-submitting": String(props.submitting) }, [
            h(
              "button",
              {
                class: "sheet-submit",
                onClick: () => emit("submit", { category: "inaccurate", comment: "wrong verse" }),
              },
              "submit"
            ),
            h("button", { class: "sheet-cancel", onClick: () => emit("cancel") }, "cancel"),
          ])
        : null,
})

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@tabler/icons-vue", () => ({
  IconCopy: icon("IconCopy"),
  IconRefresh: icon("IconRefresh"),
  IconShare: icon("IconShare"),
  IconThumbDown: icon("IconThumbDown"),
  IconThumbUp: icon("IconThumbUp"),
}))
vi.mock("../FeedbackSheet.vue", () => ({ default: FeedbackSheetStub }))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    shareService: {
      copyToClipboard: async (text: string) => void copied.push(text),
      share: async (req: { text: string }) => void sharedTexts.push(req.text),
    },
  }),
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({
    info: async (text: string) => void toasts.push({ level: "info", text }),
    error: async (text: string) => void toasts.push({ level: "error", text }),
  }),
}))
vi.mock("@lectorium/stores/useChatStore.js", () => ({
  useChatStore: () => ({
    submitFeedback: async (messageId: string, args: Omit<FeedbackCall, "messageId">) => {
      if (gateFeedback) await new Promise<void>((r) => (releaseFeedback = r))
      if (feedbackFails) throw new Error("offline")
      feedback.push({ messageId, ...args })
    },
  }),
}))

const { default: ChatMessageActions } = await import("../ChatMessageActions.vue")

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null
const retries: unknown[] = []

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
  copied.length = 0
  sharedTexts.length = 0
  feedback.length = 0
  toasts.length = 0
  retries.length = 0
  feedbackFails = false
  gateFeedback = false
  releaseFeedback = null
})

function render(props: {
  markdown?: string
  retryVisible?: boolean
  retryDisabled?: boolean
  feedbackState?: "up" | "down"
}): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(ChatMessageActions, {
          markdown: props.markdown ?? "The answer.",
          retryVisible: props.retryVisible,
          retryDisabled: props.retryDisabled,
          messageId: "m1" as ChatMessageId,
          feedbackState: props.feedbackState,
          onRetry: () => retries.push(true),
        }),
    })
  )
  app.mount(host)
  return host
}

const action = (host: HTMLElement, label: string): HTMLButtonElement =>
  host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
}

describe("which actions are offered", () => {
  it("offers copy, share and both thumbs by default", () => {
    const host = render({})
    expect(host.querySelectorAll(".message-action")).toHaveLength(4)
    expect(action(host, "chat.actionRetry")).toBeNull()
  })

  it("adds retry when the parent says the turn was truncated", () => {
    const host = render({ retryVisible: true })
    expect(action(host, "chat.actionRetry")).not.toBeNull()
    expect(action(host, "chat.actionRetry").disabled).toBe(false)
  })

  it("marks the thumb that was already pressed", () => {
    const up = render({ feedbackState: "up" })
    expect(action(up, "chat.feedback.thumbsUp").classList.contains("selected")).toBe(true)
    expect(action(up, "chat.feedback.thumbsDown").classList.contains("selected")).toBe(false)
  })
})

describe("copy and share", () => {
  it("copies the trimmed markdown and says so", async () => {
    const host = render({ markdown: "  The answer.  " })
    action(host, "chat.copyAction").click()
    await settle()

    expect(copied).toEqual(["The answer."])
    expect(toasts).toEqual([{ level: "info", text: "chat.copyDone" }])
  })

  it("shares the text with no title to clutter the preview", async () => {
    const host = render({ markdown: "The answer." })
    action(host, "chat.shareAction").click()
    await settle()

    expect(sharedTexts).toEqual(["The answer."])
    expect(toasts).toEqual([])
  })

  it("does nothing at all for a blank message", async () => {
    const host = render({ markdown: "   " })
    action(host, "chat.copyAction").click()
    action(host, "chat.shareAction").click()
    await settle()

    expect(copied).toEqual([])
    expect(sharedTexts).toEqual([])
    expect(toasts).toEqual([])
  })
})

describe("retry", () => {
  it("asks the parent to re-run the turn", () => {
    const host = render({ retryVisible: true })
    action(host, "chat.actionRetry").click()
    expect(retries).toHaveLength(1)
  })

  it("stays silent while the store is still busy", () => {
    const host = render({ retryVisible: true, retryDisabled: true })
    expect(action(host, "chat.actionRetry").disabled).toBe(true)
    action(host, "chat.actionRetry").click()
    expect(retries).toEqual([])
  })
})

describe("thumbs up", () => {
  it("submits the positive verdict straight away", async () => {
    const host = render({})
    action(host, "chat.feedback.thumbsUp").click()
    await settle()

    expect(feedback).toEqual([{ messageId: "m1", state: "up" }])
    expect(host.querySelector(".sheet")).toBeNull()
  })

  it("reports a failed submission", async () => {
    feedbackFails = true
    const host = render({})
    action(host, "chat.feedback.thumbsUp").click()
    await settle()

    expect(feedback).toEqual([])
    expect(toasts).toEqual([{ level: "error", text: "chat.feedback.failed" }])
  })

  it("ignores a second press while one is in flight", async () => {
    gateFeedback = true
    const host = render({})
    action(host, "chat.feedback.thumbsUp").click()
    await settle()
    action(host, "chat.feedback.thumbsUp").click()
    await settle()

    gateFeedback = false
    releaseFeedback?.()
    await settle()

    expect(feedback).toHaveLength(1)
  })
})

describe("thumbs down", () => {
  it("asks what was wrong before submitting anything", async () => {
    const host = render({})
    action(host, "chat.feedback.thumbsDown").click()
    await nextTick()

    expect(host.querySelector(".sheet")).not.toBeNull()
    expect(feedback).toEqual([])
  })

  it("submits the category and comment the sheet collected", async () => {
    const host = render({})
    action(host, "chat.feedback.thumbsDown").click()
    await nextTick()
    ;(host.querySelector(".sheet-submit") as HTMLButtonElement).click()
    await settle()

    expect(feedback).toEqual([
      { messageId: "m1", state: "down", category: "inaccurate", comment: "wrong verse" },
    ])
    expect(host.querySelector(".sheet")).toBeNull()
  })

  it("submits nothing when the sheet is dismissed", async () => {
    const host = render({})
    action(host, "chat.feedback.thumbsDown").click()
    await nextTick()
    ;(host.querySelector(".sheet-cancel") as HTMLButtonElement).click()
    await nextTick()

    expect(host.querySelector(".sheet")).toBeNull()
    expect(feedback).toEqual([])
  })

  it("reports a failed submission and closes the sheet anyway", async () => {
    feedbackFails = true
    const host = render({})
    action(host, "chat.feedback.thumbsDown").click()
    await nextTick()
    ;(host.querySelector(".sheet-submit") as HTMLButtonElement).click()
    await settle()

    expect(feedback).toEqual([])
    expect(host.querySelector(".sheet")).toBeNull()
    expect(toasts).toEqual([{ level: "error", text: "chat.feedback.failed" }])
  })

  it("does not open the sheet while a thumbs-up is still in flight", async () => {
    gateFeedback = true
    const host = render({})
    action(host, "chat.feedback.thumbsUp").click()
    await settle()
    action(host, "chat.feedback.thumbsDown").click()
    await nextTick()

    expect(host.querySelector(".sheet")).toBeNull()

    gateFeedback = false
    releaseFeedback?.()
    await settle()
  })
})

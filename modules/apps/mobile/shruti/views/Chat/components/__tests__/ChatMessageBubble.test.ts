// @vitest-environment jsdom
/**
 * The bubble picks one of four shapes for a message: the Ask-Sadhu focus card,
 * a user line, a failure notice, or streaming/finished assistant prose. What
 * each shape shows is the whole of what the reader gets, so the degraded
 * payloads (no status key, no suggestions, an empty truncated stream) matter as
 * much as the happy one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"
import type { ChatMessageId, ChatSessionId, TrackId } from "@lib/domain/core.js"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"

/* -- Module doubles ----------------------------------------------------- */

const FALLBACK_CHIPS = ["What does this mean?", "Give me the context"]

const state = vi.hoisted(() => ({
  /** Whatever `tm("chat.focusFallbackSuggestions")` hands back — a locale
   *  bundle can be missing the list or hold non-strings. */
  fallbackChips: [] as unknown[] | undefined,
  sending: false,
  composeBlocked: false,
}))

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length > 0 ? `${key}(${Object.values(params).join(",")})` : key,
    te: (key: string) => key === "chat.status.researching",
    tm: () => state.fallbackChips,
  }),
}))

vi.mock("@shruti/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ({ value: "en" }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({
    get sending() {
      return state.sending
    },
    get isComposeBlocked() {
      return state.composeBlocked
    },
  }),
}))
// The real export composable runs; only its catalog lookups are doubled.
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      tracks: { getById: async () => null },
      authors: { getById: async () => null },
    }),
  }),
}))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ({ value: ["en"] }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({ ensureLoaded: async () => {}, sourceNamesById: new Map() }),
}))

vi.mock("../CitationCardContainer.vue", () => ({
  default: defineComponent({
    name: "CitationCardContainer",
    props: {
      trackId: { type: String, required: true },
      startMs: { type: Number, required: true },
      endMs: { type: Number, required: true },
      body: { type: Object, required: true },
    },
    setup: (props) => () =>
      h(
        "citation-card",
        { "data-range": `${props.trackId}@${props.startMs}-${props.endMs}` },
        (props.body as { text: string }).text
      ),
  }),
}))
vi.mock("../ChatTokenRenderer.vue", () => ({
  default: defineComponent({
    name: "ChatTokenRenderer",
    props: { message: { type: Object, required: true }, quotaLocked: Boolean },
    setup: (props) => () =>
      h(
        "token-renderer",
        { "data-locked": String(props.quotaLocked) },
        (props.message as ChatMessage).content
      ),
  }),
}))
vi.mock("../ChatStatusPill.vue", () => ({
  default: defineComponent({
    name: "ChatStatusPill",
    props: { statusLabel: String },
    setup: (props) => () => h("status-pill", props.statusLabel ?? ""),
  }),
}))
vi.mock("../ChatFailureNotice.vue", () => ({
  default: defineComponent({
    name: "ChatFailureNotice",
    props: { message: { type: Object, required: true }, isLast: Boolean },
    emits: ["retry"],
    setup:
      (props, { emit }) =>
      () =>
        h(
          "button",
          {
            class: "failure",
            onClick: () => emit("retry", (props.message as ChatMessage).id),
          },
          "failed"
        ),
  }),
}))
vi.mock("../ChatMessageActions.vue", () => ({
  default: defineComponent({
    name: "ChatMessageActions",
    props: { markdown: String, retryVisible: Boolean, retryDisabled: Boolean },
    emits: ["retry"],
    setup:
      (props, { emit }) =>
      () =>
        h("actions", [
          h("span", { class: "markdown" }, props.markdown ?? ""),
          props.retryVisible
            ? h(
                "button",
                {
                  class: "retry",
                  disabled: props.retryDisabled,
                  onClick: () => emit("retry"),
                },
                "retry"
              )
            : null,
        ]),
  }),
}))

const { default: ChatMessageBubble } = await import("../ChatMessageBubble.vue")

type BubbleProps = InstanceType<typeof ChatMessageBubble>["$props"]

/* -- Fixtures ----------------------------------------------------------- */

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m-1" as ChatMessageId,
    sessionId: "s-1" as ChatSessionId,
    role: "assistant",
    content: "The soul is eternal.",
    createdAt: 1_700_000_000_000,
    ...over,
  }
}

function focusMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return message({
    role: "user",
    content: "dehino 'smin yathā dehe",
    focus: {
      trackId: "t-1" as TrackId,
      startMs: 5000,
      endMs: 8000,
      text: "dehino 'smin yathā dehe",
    },
    ...over,
  })
}

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

interface Rendered {
  readonly host: HTMLElement
  readonly retries: string[]
  readonly suggestions: string[]
}

function render(props: BubbleProps): Rendered {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const retries: string[] = []
  const suggestions: string[] = []
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(ChatMessageBubble, {
          ...props,
          onRetry: (id: string) => retries.push(id),
          "onSend-suggestion": (text: string) => suggestions.push(text),
        }),
    })
  )
  app.mount(host)
  return { host, retries, suggestions }
}

const chips = (host: HTMLElement): string[] =>
  Array.from(host.querySelectorAll(".chip")).map((el) => el.textContent?.trim() ?? "")

beforeEach(() => {
  state.fallbackChips = [...FALLBACK_CHIPS]
  state.sending = false
  state.composeBlocked = false
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

/* -- Cases -------------------------------------------------------------- */

describe("an Ask-Sadhu focus message", () => {
  it("renders the tapped fragment as a citation, not as a user bubble", () => {
    const { host } = render({ message: focusMessage() })

    expect(host.querySelector("citation-card")?.getAttribute("data-range")).toBe("t-1@5000-8000")
    expect(host.querySelector("citation-card")?.textContent).toBe("dehino 'smin yathā dehe")
    expect(host.querySelector(".bubble-row")).toBeNull()
  })

  it("says it is picking questions while they are being fetched", () => {
    const { host } = render({ message: focusMessage(), focusLoading: true })

    expect(host.querySelector("status-pill")?.textContent).toBe("chat.status.picking_questions")
    expect(chips(host)).toEqual([])
  })

  it("offers the server's own questions once they arrive", () => {
    const { host } = render({
      message: focusMessage(),
      focusSuggestions: ["Who is speaking here?", "What verse is this?"],
    })

    expect(chips(host)).toEqual(["Who is speaking here?", "What verse is this?"])
  })

  it("falls back to the static questions before the fetch resolves", () => {
    const { host } = render({ message: focusMessage(), focusSuggestions: null })

    expect(chips(host)).toEqual(FALLBACK_CHIPS)
  })

  it("falls back again when the server answered with nothing", () => {
    const { host } = render({ message: focusMessage(), focusSuggestions: [] })

    expect(chips(host)).toEqual(FALLBACK_CHIPS)
  })

  it("shows no chip row at all when there is no static list either", () => {
    state.fallbackChips = undefined
    const { host } = render({ message: focusMessage(), focusSuggestions: [] })

    expect(chips(host)).toEqual([])
  })

  it("keeps only the strings out of a malformed static list", () => {
    state.fallbackChips = ["Real question", "  ", 42, null]
    const { host } = render({ message: focusMessage(), focusSuggestions: null })

    expect(chips(host)).toEqual(["Real question"])
  })

  it("sends the question that was tapped", async () => {
    const rendered = render({
      message: focusMessage(),
      focusSuggestions: ["Who is speaking here?"],
    })
    rendered.host.querySelector<HTMLButtonElement>(".chip")!.click()
    await nextTick()

    expect(rendered.suggestions).toEqual(["Who is speaking here?"])
  })

  it("takes the chips out of service while the quota lock is armed", () => {
    const { host } = render({
      message: focusMessage(),
      focusSuggestions: ["Who is speaking here?"],
      quotaLocked: true,
    })

    expect(host.querySelector<HTMLButtonElement>(".chip")!.disabled).toBe(true)
  })
})

describe("a user message", () => {
  it("shows what was typed, verbatim", () => {
    const { host } = render({ message: message({ role: "user", content: "  Who am I?  " }) })

    expect(host.querySelector(".user-text")?.textContent).toBe("  Who am I?  ")
    expect(host.querySelector(".bubble-row")?.classList.contains("user")).toBe(true)
  })

  it("carries no actions row — there is nothing to copy or retry", () => {
    const { host } = render({ message: message({ role: "user", content: "Who am I?" }) })

    expect(host.querySelector("actions")).toBeNull()
  })
})

describe("an assistant message that is still streaming", () => {
  it("names the stage the server reported", () => {
    const { host } = render({
      message: message({ streaming: true, statusKey: "researching", content: "" }),
    })

    expect(host.querySelector("status-pill")?.textContent).toBe("chat.status.researching")
  })

  it("falls back to thinking for a stage this build has no wording for", () => {
    const { host } = render({
      message: message({ streaming: true, statusKey: "reticulating_splines", content: "" }),
    })

    expect(host.querySelector("status-pill")?.textContent).toBe("chat.status.thinking")
  })

  it("falls back to thinking when the server named no stage at all", () => {
    const { host } = render({ message: message({ streaming: true, content: "" }) })

    expect(host.querySelector("status-pill")?.textContent).toBe("chat.status.thinking")
  })

  it("keeps the pill up alongside the prose that has already landed", () => {
    const { host } = render({ message: message({ streaming: true, content: "The soul" }) })

    expect(host.querySelector("token-renderer")?.textContent).toBe("The soul")
    expect(host.querySelector("status-pill")).not.toBeNull()
  })

  it("offers no actions row before the answer is finished", () => {
    const { host } = render({ message: message({ streaming: true, content: "The soul" }) })

    expect(host.querySelector("actions")).toBeNull()
  })
})

describe("an assistant message that failed", () => {
  const failed = message({ error: { kind: "failed", code: "rate_limited" } })

  it("replaces the prose with the failure notice", () => {
    const { host } = render({ message: failed, isLast: true })

    expect(host.querySelector(".failure")).not.toBeNull()
    expect(host.querySelector("token-renderer")).toBeNull()
  })

  it("passes the retry up to the conversation", async () => {
    const rendered = render({ message: failed, isLast: true })
    rendered.host.querySelector<HTMLElement>(".failure")!.click()
    await nextTick()

    expect(rendered.retries).toEqual(["m-1"])
  })
})

describe("an assistant message that was cut off", () => {
  const truncated = message({ error: { kind: "truncated", reason: "stream" } })

  it("marks the prose as interrupted", () => {
    const { host } = render({ message: truncated, isLast: true })

    expect(host.querySelector(".truncated-suffix")?.textContent?.trim()).toBe(
      "chat.errTruncatedStream"
    )
  })

  it("offers Retry on the trailing message", async () => {
    const rendered = render({ message: truncated, isLast: true })
    const retry = rendered.host.querySelector<HTMLButtonElement>(".retry")
    expect(retry).not.toBeNull()

    retry!.click()
    await nextTick()
    expect(rendered.retries).toEqual(["m-1"])
  })

  it("offers no Retry further up the thread", () => {
    const { host } = render({ message: truncated, isLast: false })

    expect(host.querySelector(".retry")).toBeNull()
  })

  it("keeps the actions row even when the cut-off answer is empty", () => {
    const { host } = render({
      message: message({ content: "", error: { kind: "truncated", reason: "stream" } }),
      isLast: true,
    })

    expect(host.querySelector(".retry")).not.toBeNull()
    expect(host.querySelector(".markdown")?.textContent).toBe("")
  })

  it("disables Retry while another turn is already in flight", () => {
    state.sending = true
    const { host } = render({ message: truncated, isLast: true })

    expect(host.querySelector<HTMLButtonElement>(".retry")!.disabled).toBe(true)
  })

  it("disables Retry while the quota lock is armed", () => {
    state.composeBlocked = true
    const { host } = render({ message: truncated, isLast: true })

    expect(host.querySelector<HTMLButtonElement>(".retry")!.disabled).toBe(true)
  })
})

describe("a finished assistant answer", () => {
  it("shows the prose with the actions row that can copy it", () => {
    const { host } = render({ message: message() })

    expect(host.querySelector("token-renderer")?.textContent).toBe("The soul is eternal.")
    expect(host.querySelector(".markdown")?.textContent).toBe("The soul is eternal.")
    expect(host.querySelector("status-pill")).toBeNull()
  })

  it("dims the inline chapter rows while the quota lock is armed", () => {
    const { host } = render({ message: message(), quotaLocked: true })

    expect(host.querySelector("token-renderer")?.getAttribute("data-locked")).toBe("true")
  })

  it("shows nothing at all for an answer that never produced a word", () => {
    const { host } = render({ message: message({ content: "" }) })

    expect(host.querySelector("token-renderer")).toBeNull()
    expect(host.querySelector("actions")).toBeNull()
  })
})

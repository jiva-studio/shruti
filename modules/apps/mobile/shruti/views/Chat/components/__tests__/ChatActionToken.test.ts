// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"
import type { ChatActionPayload, ChatActionState } from "@lib/domain/chatMessage.js"
import type { ChatMessage } from "@shruti/stores/chat/chatTypes.js"

/* -- Module doubles ----------------------------------------------------- */

/** Every action card, as the one DOM node its kind writes. The payload it was
 *  handed is readable from the node, as is the state it renders in. */
const cardStub = (kind: string) =>
  defineComponent({
    name: `Card-${kind}`,
    props: {
      actionId: { type: String, required: true },
      payload: { type: Object, default: undefined },
      state: { type: String, default: "pending" },
      alreadyInLibrary: { type: Boolean, default: false },
      liveStatus: { type: Object, default: undefined },
      selectable: { type: Boolean, default: false },
    },
    emits: ["confirm", "open"],
    setup:
      (p, { emit }) =>
      () =>
        h(
          "div",
          {
            class: `card ${kind}`,
            "data-state": p.state,
            "data-id": (p.payload as { id?: string } | undefined)?.id ?? "no-payload",
            "data-in-library": String(p.alreadyInLibrary),
            "data-selectable": String(p.selectable),
          },
          [
            h("span", { class: "stage" }, (p.liveStatus as { label?: string } | undefined)?.label),
            h(
              "button",
              { class: "confirm", onClick: () => emit("confirm", p.actionId, { time: "07:30" }) },
              "confirm"
            ),
            h("button", { class: "open", onClick: () => emit("open") }, "open"),
          ]
        ),
  })

const executed: { messageId: string; actionId: string; override?: { time?: string } }[] = []
const routes: string[] = []
const opened: (string | undefined)[] = []
let libraryUrls: string[] = []
let readyUrls: string[] = []
let stageFor: Record<string, string> = {}

vi.mock("@shruti/router/index.js", () => ({
  default: {
    push: (path: string) => {
      routes.push(path)
      return Promise.resolve()
    },
  },
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({
    executeAction: async (messageId: string, actionId: string, override?: { time?: string }) => {
      executed.push({ messageId, actionId, override })
    },
  }),
}))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({
    ensureLoaded: async () => undefined,
    hasSource: (url: string) => libraryUrls.includes(url),
  }),
}))
vi.mock("@shruti/composables/useIngestStatusFor.js", () => ({
  useIngestStatusFor: () => (url: string | undefined) =>
    url && stageFor[url] ? { kind: "pending", label: stageFor[url] } : undefined,
}))
vi.mock("@shruti/composables/useOpenAddedLecture.js", () => ({
  useOpenAddedLecture: () => ({
    canOpen: (url: string | undefined) => !!url && readyUrls.includes(url),
    open: (url: string | undefined) => void opened.push(url),
  }),
}))
vi.mock("../ActionCardSharePdf.vue", () => ({ default: cardStub("share-pdf") }))
vi.mock("../ActionCardEnableReminder.vue", () => ({ default: cardStub("reminder") }))
vi.mock("../ActionCardConfigureSmartLibrary.vue", () => ({ default: cardStub("smart-library") }))
vi.mock("../ActionCardUpgradeToPro.vue", () => ({ default: cardStub("upgrade") }))
vi.mock("../ActionCardQueueNextTrack.vue", () => ({ default: cardStub("queue-next") }))
vi.mock("../ActionCardAddToLibrary.vue", () => ({ default: cardStub("add-to-library") }))

const { default: ChatActionToken } = await import("../ChatActionToken.vue")

/* -- Fixtures ----------------------------------------------------------- */

function message(
  actions: Record<string, ChatActionPayload>,
  actionStates?: Record<string, ChatActionState>
): ChatMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content: "[action:share_pdf|id=a1]",
    createdAt: 1_700_000_000_000,
    actions,
    actionStates,
  }
}

const REMINDER: ChatActionPayload = { kind: "enable_daily_reminder", id: "a1", time: "08:00" }
const SMART_LIBRARY: ChatActionPayload = {
  kind: "configure_smart_library",
  id: "a1",
  filters: {},
}
const CANDIDATE_URL = "https://archive.example/talks/0001.mp3"
const CANDIDATE: ChatActionPayload = {
  kind: "add_to_library",
  id: "a1",
  url: CANDIDATE_URL,
  title: "A lecture the chat found",
  author: "Test Speaker",
  thumbnail: null,
}

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
  executed.length = 0
  routes.length = 0
  opened.length = 0
  libraryUrls = []
  readyUrls = []
  stageFor = {}
})

function render(msg: ChatMessage, actionKind: string, actionId = "a1"): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(ChatActionToken, { message: msg, actionId, actionKind })
  app.mount(host)
  return host
}

const card = (host: HTMLElement): HTMLElement | null => host.querySelector(".card")

describe("choosing the card for a marker", () => {
  it("renders the card the kind names, with that kind's payload", () => {
    const host = render(message({ a1: REMINDER }), "enable_daily_reminder")
    expect(card(host)?.classList.contains("reminder")).toBe(true)
    expect(card(host)?.getAttribute("data-id")).toBe("a1")
  })

  it("renders nothing for a kind this build has no card for", () => {
    const host = render(message({ a1: REMINDER }), "teleport_user")
    expect(card(host)).toBeNull()
  })

  it("withholds the payload when the stored action is of another kind", () => {
    // A marker saying `share_pdf` over a stored reminder: the card must get
    // nothing rather than a payload it cannot read.
    const host = render(message({ a1: REMINDER }), "share_pdf")
    expect(card(host)?.classList.contains("share-pdf")).toBe(true)
    expect(card(host)?.getAttribute("data-id")).toBe("no-payload")
  })

  it("withholds the payload when the message carries no actions at all", () => {
    const host = render(message({}), "share_pdf")
    expect(card(host)?.getAttribute("data-id")).toBe("no-payload")
  })
})

describe("the state the card renders in", () => {
  it("passes through the four states the cards draw", () => {
    for (const state of ["executing", "done", "error"] as const) {
      const host = render(message({ a1: REMINDER }, { a1: state }), "enable_daily_reminder")
      expect(card(host)?.getAttribute("data-state")).toBe(state)
      app?.unmount()
      app = null
      host.remove()
    }
  })

  it("leaves Confirm reachable for a state the cards cannot draw", () => {
    const host = render(message({ a1: REMINDER }, { a1: "dismissed" }), "enable_daily_reminder")
    expect(card(host)?.getAttribute("data-state")).toBe("pending")
  })

  it("is pending when no state was ever recorded", () => {
    const host = render(message({ a1: REMINDER }), "enable_daily_reminder")
    expect(card(host)?.getAttribute("data-state")).toBe("pending")
  })
})

describe("confirming an action", () => {
  it("runs it on the owning message, carrying the card's override", async () => {
    const host = render(message({ a1: REMINDER }), "enable_daily_reminder")
    ;(host.querySelector(".confirm") as HTMLButtonElement).click()
    await nextTick()
    expect(executed).toEqual([{ messageId: "m1", actionId: "a1", override: { time: "07:30" } }])
    expect(routes).toEqual([])
  })

  it("lands the user in Settings after Smart Library was applied", async () => {
    const host = render(message({ a1: SMART_LIBRARY }), "configure_smart_library")
    ;(host.querySelector(".confirm") as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()
    expect(routes).toEqual(["/tabs/settings"])
  })

  it("routes nowhere when the stored action is not the Smart Library one", async () => {
    const host = render(message({ a1: REMINDER }), "configure_smart_library")
    ;(host.querySelector(".confirm") as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()
    expect(executed).toHaveLength(1)
    expect(routes).toEqual([])
  })
})

describe("an offered lecture", () => {
  it("is marked as held once the library has that source", () => {
    libraryUrls = [CANDIDATE_URL]
    const host = render(message({ a1: CANDIDATE }), "add_to_library")
    expect(card(host)?.getAttribute("data-in-library")).toBe("true")
  })

  it("is not marked as held while it is only being offered", () => {
    const host = render(message({ a1: CANDIDATE }), "add_to_library")
    expect(card(host)?.getAttribute("data-in-library")).toBe("false")
    expect(card(host)?.getAttribute("data-selectable")).toBe("false")
  })

  it("names the stage it is at while the fetch runs", () => {
    stageFor = { [CANDIDATE_URL]: "Transcribing" }
    const host = render(message({ a1: CANDIDATE }), "add_to_library")
    expect(host.querySelector(".stage")?.textContent).toBe("Transcribing")
  })

  it("opens what the candidate's url resolves to", async () => {
    readyUrls = [CANDIDATE_URL]
    const host = render(message({ a1: CANDIDATE }), "add_to_library")
    expect(card(host)?.getAttribute("data-selectable")).toBe("true")
    ;(host.querySelector(".open") as HTMLButtonElement).click()
    await nextTick()
    expect(opened).toEqual([CANDIDATE_URL])
  })

  it("offers nothing to open when the marker has no candidate behind it", () => {
    readyUrls = [CANDIDATE_URL]
    stageFor = { [CANDIDATE_URL]: "Transcribing" }
    const host = render(message({}), "add_to_library")
    expect(card(host)?.getAttribute("data-selectable")).toBe("false")
    expect(host.querySelector(".stage")?.textContent).toBe("")
  })
})

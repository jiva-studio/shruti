// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"
import type { ChatSharePdfItemPayload, ChatSharePdfRefPayload } from "@lib/domain/chatMessage.js"

/* -- Module doubles ----------------------------------------------------- */

interface RenderRequest {
  readonly trackId: string
  readonly lang: string
  readonly transcriptKey?: string
}

const rendered: RenderRequest[] = []
const shared: { url: string; title: string; dialogTitle?: string }[] = []
const toasts: { level: string; text: string }[] = []
/** Share slots taken but not yet released — a leak shows up as a leftover. */
const slots: string[] = []

let renderFails = false
let shareFails = false
let slotBusy = false
let gateRender = false
let releaseRender: ((value: string) => void) | null = null

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  IonSpinner: defineComponent({ name: "IonSpinner", setup: () => () => h("span") }),
}))
vi.mock("@tabler/icons-vue", () => ({
  IconFileTypePdf: defineComponent({ name: "IconFileTypePdf", setup: () => () => h("span") }),
}))
vi.mock("@lib/ui/chat/ScriptureChip.vue", () => ({
  default: defineComponent({
    name: "ScriptureChip",
    props: { caption: String },
    setup: (p) => () => h("span", { class: "chip" }, p.caption),
  }),
}))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    shareService: {
      share: async (req: { url: string; title: string; dialogTitle?: string }) => {
        if (shareFails) throw new Error("share sheet dismissed")
        shared.push(req)
      },
    },
  }),
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({
    info: async (text: string) => void toasts.push({ level: "info", text }),
    error: async (text: string) => void toasts.push({ level: "error", text }),
  }),
}))
vi.mock("@lectorium/stores/useShareJobStore.js", () => ({
  useShareJobStore: () => ({
    tryStart: (kind: string, key: string) => {
      if (slotBusy) return false
      slots.push(`${kind}:${key}`)
      return true
    },
    finish: () => void slots.pop(),
  }),
}))
vi.mock("@lectorium/composables/useShareBackgroundOnLeave.js", () => ({
  useShareBackgroundOnLeave: () => undefined,
}))
vi.mock("@lectorium/composables/useShareTranscript.js", () => ({
  useShareTranscript: () => ({
    prepareLocalPdf: async (req: RenderRequest) => {
      rendered.push(req)
      if (gateRender) return new Promise<string>((r) => (releaseRender = r))
      if (renderFails) throw new Error("render failed")
      return `file:///tmp/${req.trackId}-${req.lang}.pdf`
    },
  }),
}))

const { default: ActionCardSharePdf } = await import("../ActionCardSharePdf.vue")

/* -- Fixtures ----------------------------------------------------------- */

/** Every label field is on the wire; the server nulls the ones it has no
 *  value for, so a fixture must too. */
function ref(over: Partial<ChatSharePdfRefPayload> = {}): ChatSharePdfRefPayload {
  return { shortName: null, fullName: null, sourceId: null, tokens: null, ...over }
}

function item(over: Partial<ChatSharePdfItemPayload> = {}): ChatSharePdfItemPayload {
  return {
    trackId: "t1",
    lang: "en",
    title: "Evening lecture",
    author: "Gour Govinda Swami",
    date: "1991-02-03",
    location: "Bhubaneswar",
    references: [],
    tags: [],
    transcriptKey: "transcripts/t1/en.json",
    ...over,
  } as ChatSharePdfItemPayload
}

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
  rendered.length = 0
  shared.length = 0
  toasts.length = 0
  slots.length = 0
  renderFails = false
  shareFails = false
  slotBusy = false
  gateRender = false
  releaseRender = null
})

function mountCard(items: readonly ChatSharePdfItemPayload[] | null): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(ActionCardSharePdf, {
    actionId: "a1",
    payload: items === null ? undefined : { kind: "share_pdf", id: "a1", items },
  })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return host
}

const rows = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>(".pdf-row"))

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

describe("what the card renders", () => {
  it("lists one row per item with its title and meta", () => {
    const host = mountCard([item(), item({ trackId: "t2", title: "Morning class" })])
    expect(rows(host)).toHaveLength(2)
    expect(host.querySelector(".pdf-title")?.textContent).toBe("Evening lecture")
    expect(host.querySelector(".pdf-meta")?.textContent).toBe("Gour Govinda Swami · 1991-02-03")
  })

  it("drops the separator when only the date is known", () => {
    const host = mountCard([item({ author: null })])
    expect(host.querySelector(".pdf-meta")?.textContent).toBe("1991-02-03")
  })

  it("hides the meta line when neither author nor date is known", () => {
    const host = mountCard([item({ author: null, date: null })])
    expect(host.querySelector(".pdf-meta")).toBeNull()
  })

  it("captions reference chips from whichever label the server sent", () => {
    const host = mountCard([
      item({
        references: [
          ref({ shortName: "BG", tokens: "2.13" }),
          ref({ fullName: "Srimad Bhagavatam", tokens: "5.5.3" }),
          ref({ sourceId: "cc", tokens: "" }),
        ],
      }),
    ])
    expect(Array.from(host.querySelectorAll(".chip")).map((c) => c.textContent)).toEqual([
      "BG 2.13",
      "Srimad Bhagavatam 5.5.3",
      "cc",
    ])
  })

  it("shows a degraded notice instead of an empty list when the payload is gone", () => {
    const host = mountCard(null)
    expect(host.querySelector(".pdf-list")).toBeNull()
    expect(host.querySelector(".pdf-broken-text")?.textContent).toBe("chat.actionDegraded")
  })

  it("renders an empty list rather than the degraded notice for zero items", () => {
    const host = mountCard([])
    expect(host.querySelector(".pdf-list")).not.toBeNull()
    expect(host.querySelector(".pdf-broken")).toBeNull()
  })
})

describe("sharing a row", () => {
  it("renders the transcript and hands the file to the share sheet", async () => {
    const host = mountCard([item()])
    rows(host)[0].click()
    await settle()

    expect(rendered[0]).toMatchObject({
      trackId: "t1",
      lang: "en",
      transcriptKey: "transcripts/t1/en.json",
    })
    expect(shared).toEqual([
      {
        url: "file:///tmp/t1-en.pdf",
        title: "Evening lecture",
        dialogTitle: "chat.actionPdfDialog",
      },
    ])
    expect(rows(host)[0].dataset.state).toBe("shared")
    expect(slots).toEqual([])
  })

  it("defaults a blank language to Russian", async () => {
    const host = mountCard([item({ lang: "" })])
    rows(host)[0].click()
    await settle()
    expect(rendered[0].lang).toBe("ru")
  })

  it("leaves the other rows idle", async () => {
    const host = mountCard([item(), item({ trackId: "t2" })])
    rows(host)[0].click()
    await settle()
    expect(rows(host).map((r) => r.dataset.state)).toEqual(["shared", "idle"])
  })

  it("lets a shared row be shared again", async () => {
    const host = mountCard([item()])
    rows(host)[0].click()
    await settle()
    rows(host)[0].click()
    await settle()
    expect(shared).toHaveLength(2)
  })
})

describe("rows that cannot be shared", () => {
  it("refuses an item stored before the transcript key existed", async () => {
    const host = mountCard([item({ transcriptKey: undefined })])
    rows(host)[0].click()
    await settle()

    expect(rendered).toEqual([])
    expect(shared).toEqual([])
    expect(rows(host)[0].dataset.state).toBe("error")
    expect(toasts).toEqual([{ level: "error", text: "chat.actionPdfError" }])
  })

  it("marks the row and frees the slot when the render fails", async () => {
    renderFails = true
    const host = mountCard([item()])
    rows(host)[0].click()
    await settle()

    expect(rows(host)[0].dataset.state).toBe("error")
    expect(toasts).toEqual([{ level: "error", text: "chat.actionPdfError" }])
    expect(slots).toEqual([])
  })

  it("does the same when the share sheet itself fails", async () => {
    shareFails = true
    const host = mountCard([item()])
    rows(host)[0].click()
    await settle()

    expect(rows(host)[0].dataset.state).toBe("error")
    expect(slots).toEqual([])
  })

  it("stands down when another share already holds the single slot", async () => {
    slotBusy = true
    const host = mountCard([item()])
    rows(host)[0].click()
    await settle()

    expect(rendered).toEqual([])
    expect(rows(host)[0].dataset.state).toBe("idle")
    expect(toasts).toEqual([{ level: "info", text: "notes.shareAlreadyInProgress" }])
  })
})

describe("while a share is in flight", () => {
  it("marks the row busy and ignores a second tap on it", async () => {
    gateRender = true
    const host = mountCard([item()])
    rows(host)[0].click()
    await settle()

    expect(rows(host)[0].dataset.state).toBe("sharing")
    expect(rows(host)[0].getAttribute("aria-disabled")).toBe("true")

    rows(host)[0].click()
    await settle()
    expect(rendered).toHaveLength(1)

    releaseRender?.("file:///tmp/t1-en.pdf")
    await settle()
    expect(rows(host)[0].dataset.state).toBe("shared")
  })
})

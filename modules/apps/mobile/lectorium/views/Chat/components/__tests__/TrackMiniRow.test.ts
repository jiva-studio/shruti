// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue"
import type { Track } from "@lib/domain/track.js"

/* -- Module doubles ----------------------------------------------------- */

interface SheetButton {
  readonly text: string
  readonly role?: string
  readonly handler: () => void
}

/** Renders the sheet's buttons as real DOM so a test can press one. */
const ActionSheetStub = defineComponent({
  name: "IonActionSheet",
  props: { isOpen: Boolean, buttons: { type: Array, default: () => [] } },
  setup: (props) => () =>
    props.isOpen
      ? h(
          "span",
          { class: "sheet" },
          (props.buttons as SheetButton[]).map((b) =>
            h("button", { class: `sheet-btn role-${b.role ?? "none"}`, onClick: b.handler }, b.text)
          )
        )
      : null,
})

const repos = {
  tracks: { getById: vi.fn() },
  authors: { getById: vi.fn() },
  locations: { getById: vi.fn() },
  sources: { getById: vi.fn() },
}

const added: string[] = []
let addFails = false
const toasts: { level: string; text: string }[] = []

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({ IonActionSheet: ActionSheetStub }))
vi.mock("@lectorium/lectorium.js", () => ({ useLectorium: () => ({ repositories: () => repos }) }))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["ru", "en"]),
}))
vi.mock("@lectorium/composables/useAddToPlaylist.js", () => ({
  useAddToPlaylist: () => ({
    addToPlaylist: async (trackId: string) => {
      if (addFails) throw new Error("storage is full")
      added.push(trackId)
    },
  }),
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({
    info: async (text: string) => void toasts.push({ level: "info", text }),
    error: async (text: string) => void toasts.push({ level: "error", text }),
  }),
}))

const { default: TrackMiniRow } = await import("../TrackMiniRow.vue")

/* -- Fixtures ----------------------------------------------------------- */

type Variant = Track["variants"][number]

const variant = (language: string, title: string): Variant =>
  ({ language, title, audio: null }) as unknown as Variant

function track(over: Partial<Track> = {}): Track {
  return {
    id: "t1",
    authorId: null,
    locationId: null,
    date: "1991-02-03",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [variant("en", "Evening lecture")],
    ...over,
  } as Track
}

const namesOf = (pairs: Record<string, string>) => ({ names: new Map(Object.entries(pairs)) })

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
  vi.resetAllMocks()
  added.length = 0
  toasts.length = 0
  addFails = false
})

async function render(trackId = "t1"): Promise<HTMLElement> {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(TrackMiniRow, { trackId })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
  return host
}

const row = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector(".mini-row") as HTMLButtonElement

const text = (host: HTMLElement, sel: string): string =>
  host.querySelector(sel)?.textContent?.trim() ?? ""

describe("the row's own state", () => {
  it("is an inert skeleton while the track loads", async () => {
    repos.tracks.getById.mockReturnValue(new Promise(() => {}))
    const host = await render()
    expect(row(host).classList.contains("skeleton")).toBe(true)
    expect(row(host).disabled).toBe(true)
    expect(host.querySelector(".title")).toBeNull()
  })

  it("names the missing lecture and stays inert when the id is unknown", async () => {
    repos.tracks.getById.mockResolvedValue(null)
    const host = await render("gone")
    expect(row(host).classList.contains("missing")).toBe(true)
    expect(row(host).disabled).toBe(true)
    expect(text(host, ".placeholder")).toBe("chat.lectureCardMissing")
  })

  it("does the same when the lookup throws", async () => {
    repos.tracks.getById.mockRejectedValue(new Error("db closed"))
    const host = await render()
    expect(row(host).classList.contains("missing")).toBe(true)
    expect(text(host, ".placeholder")).toBe("chat.lectureCardMissing")
  })

  it("becomes a live row once the track resolves", async () => {
    repos.tracks.getById.mockResolvedValue(track())
    const host = await render()
    expect(row(host).disabled).toBe(false)
    expect(text(host, ".title")).toBe("Evening lecture")
  })
})

describe("the details line", () => {
  it("joins author, location and date in that order", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({
        authorId: "a1" as Track["authorId"],
        locationId: "l1" as Track["locationId"],
      })
    )
    repos.authors.getById.mockResolvedValue(namesOf({ en: "Gour Govinda Swami" }))
    repos.locations.getById.mockResolvedValue(namesOf({ en: "Bhubaneswar" }))
    const host = await render()
    expect(text(host, ".details")).toBe("Gour Govinda Swami · Bhubaneswar · 3 Feb 1991")
  })

  it("drops the author when the dictionary has no entry for the id", async () => {
    repos.tracks.getById.mockResolvedValue(track({ authorId: "a1" as Track["authorId"] }))
    repos.authors.getById.mockResolvedValue(null)
    const host = await render()
    expect(text(host, ".details")).toBe("3 Feb 1991")
  })

  it("falls back to another locale's name rather than showing nothing", async () => {
    repos.tracks.getById.mockResolvedValue(track({ authorId: "a1" as Track["authorId"] }))
    repos.authors.getById.mockResolvedValue(namesOf({ ru: "Гоур Говинда Свами" }))
    const host = await render()
    expect(text(host, ".details")).toBe("Гоур Говинда Свами · 3 Feb 1991")
  })

  it("passes a year-only date through unchanged", async () => {
    repos.tracks.getById.mockResolvedValue(track({ date: "1991" as Track["date"] }))
    const host = await render()
    expect(text(host, ".details")).toBe("1991")
  })

  it("hides the line entirely when the track carries none of it", async () => {
    repos.tracks.getById.mockResolvedValue(track({ date: "" as Track["date"] }))
    const host = await render()
    expect(host.querySelector(".details")).toBeNull()
    expect(text(host, ".title")).toBe("Evening lecture")
  })
})

describe("reference chips", () => {
  const source = {
    id: "sb",
    names: new Map([["en", { shortName: "SB", fullName: "Srimad Bhagavatam" }]]),
  }

  it("shows the first chip and counts the rest", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({
        references: [
          { sourceId: "sb", tokens: ["5", "5", "3"] },
          { sourceId: "sb", tokens: ["1", "1", "1"] },
        ] as unknown as Track["references"],
      })
    )
    repos.sources.getById.mockResolvedValue(source)
    const host = await render()
    expect(text(host, ".ref")).toBe("SB 5.5.3")
    expect(text(host, ".ref.extra")).toBe("+1")
  })

  it("names an external book that has no catalog source", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({
        references: [
          { sourceName: "Nectar of Devotion", tokens: ["12"] },
        ] as unknown as Track["references"],
      })
    )
    const host = await render()
    expect(text(host, ".ref")).toBe("Nectar of Devotion 12")
  })

  it("shows no chip when the track cites nothing", async () => {
    repos.tracks.getById.mockResolvedValue(track())
    const host = await render()
    expect(host.querySelector(".ref")).toBeNull()
  })
})

describe("adding from the row", () => {
  it("adds the track through the sheet", async () => {
    repos.tracks.getById.mockResolvedValue(track())
    const host = await render("t7")

    row(host).click()
    await nextTick()
    expect(Array.from(host.querySelectorAll(".sheet-btn")).map((b) => b.textContent)).toEqual([
      "search.actions.addToPlaylist",
      "app.cancel",
    ])
    ;(host.querySelector(".sheet-btn") as HTMLButtonElement).click()
    for (let i = 0; i < 3; i++) await Promise.resolve()

    expect(added).toEqual(["t7"])
    expect(toasts).toEqual([{ level: "info", text: "chat.citationAddedToPlaylist" }])
  })

  it("reports the failure instead of claiming the track was added", async () => {
    repos.tracks.getById.mockResolvedValue(track())
    addFails = true
    const host = await render()

    row(host).click()
    await nextTick()
    ;(host.querySelector(".sheet-btn") as HTMLButtonElement).click()
    for (let i = 0; i < 4; i++) await Promise.resolve()

    expect(added).toEqual([])
    expect(toasts).toEqual([{ level: "error", text: "chat.citationAddFailed" }])
  })

  it("opens no sheet for a row whose track is missing", async () => {
    repos.tracks.getById.mockResolvedValue(null)
    const host = await render()
    row(host).click()
    await nextTick()
    expect(host.querySelector(".sheet")).toBeNull()
  })
})

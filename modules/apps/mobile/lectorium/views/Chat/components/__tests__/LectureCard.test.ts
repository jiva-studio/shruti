// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue"
import type { Track } from "@lib/domain/track.js"

/* -- Module doubles ----------------------------------------------------- */

const stub = (name: string, tag = "div") => defineComponent({ name, setup: () => () => h(tag) })

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
          "div",
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
vi.mock("@ionic/vue", () => ({ IonActionSheet: ActionSheetStub, IonSpinner: stub("IonSpinner") }))
vi.mock("@tabler/icons-vue", () => ({ IconHeadphones: stub("IconHeadphones", "span") }))
vi.mock("@lectorium/lectorium.js", () => ({ useLectorium: () => ({ repositories: () => repos }) }))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["ru", "en"]),
}))
vi.mock("@lectorium/composables/useDurationFormatter.js", () => ({
  useDurationFormatter: () => (seconds: number) => `${seconds}s`,
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

const { default: LectureCard } = await import("../LectureCard.vue")

/* -- Fixtures ----------------------------------------------------------- */

type Variant = Track["variants"][number]

function variant(language: string, title: string, durationMs?: number): Variant {
  return {
    language,
    title,
    audio: durationMs === undefined ? null : { duration: durationMs },
  } as unknown as Variant
}

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
    variants: [variant("ru", "Вечерняя лекция", 3_600_000)],
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

/** Mount the card and let the loader cascade settle. */
async function render(trackId = "t1"): Promise<HTMLElement> {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(LectureCard, { trackId })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
  return host
}

const text = (host: HTMLElement, sel: string): string =>
  host.querySelector(sel)?.textContent?.trim() ?? ""

describe("while the track is loading", () => {
  it("shows a spinner and no title", async () => {
    repos.tracks.getById.mockReturnValue(new Promise(() => {}))
    const host = await render()
    expect(host.querySelector(".placeholder")).not.toBeNull()
    expect(host.querySelector(".title")).toBeNull()
  })
})

describe("when the track cannot be resolved", () => {
  it("says the lecture is missing if the catalog has no such id", async () => {
    repos.tracks.getById.mockResolvedValue(null)
    const host = await render("gone")
    expect(text(host, ".placeholder.error")).toBe("chat.lectureCardMissing")
    expect(host.querySelector(".title")).toBeNull()
  })

  it("says the same when the lookup throws", async () => {
    repos.tracks.getById.mockRejectedValue(new Error("db closed"))
    const host = await render()
    expect(text(host, ".placeholder.error")).toBe("chat.lectureCardMissing")
  })

  it("does not open the action sheet on a tap", async () => {
    repos.tracks.getById.mockResolvedValue(null)
    const host = await render()
    ;(host.querySelector(".lecture-card") as HTMLElement).click()
    await nextTick()
    expect(host.querySelector(".sheet")).toBeNull()
  })
})

describe("the resolved row", () => {
  it("prefers the interface language among the library languages the track has", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({ variants: [variant("ru", "Вечерняя лекция"), variant("en", "Evening lecture")] })
    )
    const host = await render()
    expect(text(host, ".title")).toBe("Evening lecture")
  })

  it("titles the card in the library language when the interface language is absent", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({ variants: [variant("ru", "Вечерняя лекция"), variant("hi", "संध्या प्रवचन")] })
    )
    const host = await render()
    expect(text(host, ".title")).toBe("Вечерняя лекция")
  })

  it("falls back to the first variant when the track has no library language", async () => {
    repos.tracks.getById.mockResolvedValue(track({ variants: [variant("hi", "संध्या प्रवचन")] }))
    const host = await render()
    expect(text(host, ".title")).toBe("संध्या प्रवचन")
  })

  it("shows the raw id when every variant title is blank", async () => {
    repos.tracks.getById.mockResolvedValue(track({ variants: [variant("ru", "")] }))
    const host = await render()
    expect(text(host, ".title")).toBe("t1")
  })

  it("joins location, date and duration into one meta line", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({ locationId: "l1" as Track["locationId"], variants: [variant("ru", "T", 90_000)] })
    )
    repos.locations.getById.mockResolvedValue(namesOf({ en: "Bhubaneswar" }))
    const host = await render()
    expect(text(host, ".details")).toBe("Bhubaneswar · 3 Feb 1991 · 90s")
  })

  it("leaves out the parts the payload does not carry", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({ date: "" as Track["date"], variants: [variant("ru", "T")] })
    )
    const host = await render()
    expect(host.querySelector(".details")).toBeNull()
  })

  it("takes the longest variant's duration", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({
        date: "" as Track["date"],
        variants: [variant("ru", "T", 60_000), variant("en", "T", 120_000)],
      })
    )
    const host = await render()
    expect(text(host, ".details")).toBe("120s")
  })
})

describe("scripture references", () => {
  const source = {
    id: "bg",
    names: new Map([["en", { shortName: "BG", fullName: "Bhagavad-gita" }]]),
  }

  it("shows the first reference and folds the rest into a count", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({
        references: [
          { sourceId: "bg", tokens: ["2", "13"] },
          { sourceId: "bg", tokens: ["9", "1"] },
          { sourceId: "bg", tokens: ["11", "4"] },
        ] as unknown as Track["references"],
      })
    )
    repos.sources.getById.mockResolvedValue(source)
    const host = await render()
    expect(text(host, ".ref")).toBe("BG 2.13")
    expect(text(host, ".ref.extra")).toBe("+2")
  })

  it("collapses a consecutive run into a single range chip", async () => {
    repos.tracks.getById.mockResolvedValue(
      track({
        references: [
          { sourceId: "bg", tokens: ["2", "13"] },
          { sourceId: "bg", tokens: ["2", "14"] },
        ] as unknown as Track["references"],
      })
    )
    repos.sources.getById.mockResolvedValue(source)
    const host = await render()
    expect(text(host, ".ref")).toBe("BG 2.13–14")
    expect(host.querySelector(".ref.extra")).toBeNull()
  })

  it("shows no chip for a track with no references", async () => {
    repos.tracks.getById.mockResolvedValue(track())
    const host = await render()
    expect(host.querySelector(".ref")).toBeNull()
  })
})

describe("adding the lecture to the playlist", () => {
  it("offers the action through the sheet and adds the track", async () => {
    repos.tracks.getById.mockResolvedValue(track())
    const host = await render("t1")

    ;(host.querySelector(".lecture-card") as HTMLElement).click()
    await nextTick()

    const buttons = Array.from(host.querySelectorAll(".sheet-btn")).map((b) => b.textContent)
    expect(buttons).toEqual(["search.actions.addToPlaylist", "app.cancel"])
    ;(host.querySelector(".sheet-btn") as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()

    expect(added).toEqual(["t1"])
    expect(toasts).toEqual([{ level: "info", text: "chat.citationAddedToPlaylist" }])
  })

  it("reports a failed add instead of claiming success", async () => {
    repos.tracks.getById.mockResolvedValue(track())
    addFails = true
    const host = await render()

    ;(host.querySelector(".lecture-card") as HTMLElement).click()
    await nextTick()
    ;(host.querySelector(".sheet-btn") as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(added).toEqual([])
    expect(toasts).toEqual([{ level: "error", text: "chat.citationAddFailed" }])
  })

  it("adds nothing when the sheet is dismissed", async () => {
    repos.tracks.getById.mockResolvedValue(track())
    const host = await render()

    ;(host.querySelector(".lecture-card") as HTMLElement).click()
    await nextTick()
    ;(host.querySelector(".role-cancel") as HTMLButtonElement).click()
    await nextTick()

    expect(added).toEqual([])
    expect(toasts).toEqual([])
  })
})

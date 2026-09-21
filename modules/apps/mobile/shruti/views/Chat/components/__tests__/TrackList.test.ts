// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"

/* -- Module doubles ----------------------------------------------------- */

const attempts: string[] = []
const added: string[] = []
let failFor: (trackId: string) => boolean = () => false
let resolveAdd: ((value: void) => void) | null = null
let gateAdds = false

const toasts: { level: string; text: string; args?: Record<string, unknown> }[] = []

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (k: string, args?: Record<string, unknown>) => render(k, args) }),
}))
vi.mock("@ionic/vue", () => ({
  IonSpinner: defineComponent({ name: "IonSpinner", setup: () => () => h("span") }),
}))
vi.mock("../LectureCard.vue", () => ({
  default: defineComponent({
    name: "LectureCard",
    props: { trackId: { type: String, required: true } },
    setup: (p) => () => h("article", { class: "lecture-card" }, p.trackId),
  }),
}))
vi.mock("@shruti/composables/useAddToPlaylist.js", () => ({
  useAddToPlaylist: () => ({
    addToPlaylist: async (trackId: string) => {
      attempts.push(trackId)
      if (gateAdds) await new Promise<void>((r) => (resolveAdd = r))
      if (failFor(trackId)) throw new Error("disk full")
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

/** Interpolated key so the counts the user sees are visible to a test. */
function render(key: string, args?: Record<string, unknown>): string {
  if (!args) return key
  const parts = Object.entries(args).map(([k, v]) => `${k}=${String(v)}`)
  return `${key}(${parts.join(",")})`
}

const { default: TrackList } = await import("../TrackList.vue")

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
  attempts.length = 0
  added.length = 0
  toasts.length = 0
  failFor = () => false
  gateAdds = false
  resolveAdd = null
})

function mountList(trackIds: readonly string[]): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(TrackList, { trackIds })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return host
}

const addAll = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector(".add-all-btn") as HTMLButtonElement

/** Let every queued add settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

describe("what the list renders", () => {
  it("puts one card per id, in order", () => {
    const host = mountList(["a", "b", "c"])
    expect(Array.from(host.querySelectorAll(".lecture-card")).map((e) => e.textContent)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("renders a repeated id twice rather than collapsing it", () => {
    const host = mountList(["a", "a"])
    expect(host.querySelectorAll(".lecture-card")).toHaveLength(2)
  })

  it("offers no bulk action for a single lecture", () => {
    const host = mountList(["a"])
    expect(addAll(host)).toBeNull()
    expect(host.querySelector(".track-list")?.classList.contains("multi")).toBe(false)
  })

  it("offers the bulk action from two lectures up", () => {
    const host = mountList(["a", "b"])
    expect(addAll(host)).not.toBeNull()
    expect(host.querySelector(".track-list")?.classList.contains("multi")).toBe(true)
  })

  it("renders an empty list without a card or a button", () => {
    const host = mountList([])
    expect(host.querySelectorAll(".lecture-card")).toHaveLength(0)
    expect(addAll(host)).toBeNull()
  })
})

describe("adding every lecture at once", () => {
  it("adds them all and reports the count", async () => {
    const host = mountList(["a", "b", "c"])
    addAll(host).click()
    await settle()

    expect(added).toEqual(["a", "b", "c"])
    expect(toasts).toEqual([{ level: "info", text: "chat.trackListAddAllDone(n=3)" }])
  })

  it("keeps the partial successes and says how many were lost", async () => {
    failFor = (id) => id === "b"
    const host = mountList(["a", "b", "c"])
    addAll(host).click()
    await settle()

    expect(attempts).toEqual(["a", "b", "c"])
    expect(added).toEqual(["a", "c"])
    expect(toasts).toEqual([
      { level: "info", text: "chat.trackListAddAllPartial(added=2,failed=1)" },
    ])
  })

  it("reports an outright failure when nothing could be added", async () => {
    failFor = () => true
    const host = mountList(["a", "b"])
    addAll(host).click()
    await settle()

    expect(added).toEqual([])
    expect(toasts).toEqual([{ level: "error", text: "chat.trackListAddAllFailed" }])
  })

  it("shows a spinner and refuses a second tap while it runs", async () => {
    gateAdds = true
    const host = mountList(["a", "b"])
    addAll(host).click()
    await nextTick()

    expect(addAll(host).disabled).toBe(true)
    expect(host.querySelector(".spinner")).not.toBeNull()

    addAll(host).click()
    await nextTick()
    expect(attempts).toEqual(["a"])

    gateAdds = false
    resolveAdd?.()
    await settle()

    expect(added).toEqual(["a", "b"])
    expect(addAll(host).disabled).toBe(false)
    expect(host.querySelector(".spinner")).toBeNull()
  })
})

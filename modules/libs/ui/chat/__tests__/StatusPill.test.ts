// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, h, nextTick, reactive } from "vue"
import StatusPill from "../StatusPill.vue"

interface Props {
  statusLabel?: string
  researchQuestions?: string[]
  researchSources?: Map<string, { label: string }>
}

interface Mounted {
  host: HTMLElement
  props: Props
  label: () => string
  unmount: () => void
}

function mount(props: Props): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const app = createApp({ render: () => h(StatusPill, { ...state }) })
  app.mount(host)
  return {
    host,
    props: state,
    // The <Transition> keeps the outgoing label in the DOM, so the probe span
    // — which always carries the current item — is what the pill is showing.
    label: () => host.querySelector(".measure-probe")?.textContent ?? "",
    unmount: () => app.unmount(),
  }
}

/** Advance past one rotation tick and let the swap render. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1800)
  await nextTick()
}

/** Feed `pickNext` a fixed sequence of Math.random draws. */
function draws(values: number[]): void {
  let i = 0
  vi.spyOn(Math, "random").mockImplementation(() => values[Math.min(i++, values.length - 1)])
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("StatusPill", () => {
  it("announces the status politely", () => {
    const m = mount({ statusLabel: "Thinking" })
    const pill = m.host.querySelector(".status-pill")!

    expect(pill.getAttribute("role")).toBe("status")
    expect(pill.getAttribute("aria-live")).toBe("polite")
    expect(m.label()).toBe("Thinking")
  })

  it("stays on the status while there is nothing else to show", async () => {
    const m = mount({ statusLabel: "Thinking" })

    await tick()
    await tick()

    expect(m.label()).toBe("Thinking")
  })

  it("rotates through what the server is exploring", async () => {
    draws([0.9])
    const m = mount({ statusLabel: "Thinking", researchQuestions: ["Who is Uddhava?"] })

    expect(m.label()).toBe("Thinking")
    await tick()

    expect(m.label()).toBe("Who is Uddhava?")
  })

  it("does not land on the same item twice in a row", async () => {
    // Two draws point back at the item already shown; the third moves on.
    draws([0.9, 0.9, 0.9, 0.1])
    const m = mount({ statusLabel: "Thinking", researchQuestions: ["Who is Uddhava?"] })

    await tick()
    expect(m.label()).toBe("Who is Uddhava?")

    await tick()
    expect(m.label()).toBe("Thinking")
  })

  it("re-anchors on a new status the moment the server moves on", async () => {
    draws([0.9])
    const m = mount({ statusLabel: "Thinking", researchQuestions: ["Who is Uddhava?"] })

    await tick()
    expect(m.label()).toBe("Who is Uddhava?")

    m.props.statusLabel = "Composing answer"
    await nextTick()

    expect(m.label()).toBe("Composing answer")
  })

  it("folds source labels into the rotation", async () => {
    draws([0.9])
    const m = mount({
      statusLabel: "Reading",
      researchSources: new Map([["s1", { label: "vedabase.io" }]]),
    })

    await tick()

    expect(m.label()).toBe("vedabase.io")
  })

  it("shortens a question too long for the pill", async () => {
    draws([0.9])
    const long = "Why does Krishna tell Arjuna that the soul is never born and never dies at all"
    const m = mount({ statusLabel: "Thinking", researchQuestions: [long] })

    await tick()

    expect(m.label()).toHaveLength(56)
    expect(m.label().endsWith("…")).toBe(true)
    expect(long.startsWith(m.label().slice(0, 20))).toBe(true)
  })

  it("flattens the whitespace of a multi-line question", async () => {
    draws([0.9])
    const m = mount({ statusLabel: "Thinking", researchQuestions: ["  who   is\n Uddhava  "] })

    await tick()

    expect(m.label()).toBe("who is Uddhava")
  })

  it("ignores a blank question rather than flashing an empty pill", async () => {
    draws([0.9])
    const m = mount({ statusLabel: "Thinking", researchQuestions: ["   ", ""] })

    await tick()
    await tick()

    expect(m.label()).toBe("Thinking")
  })

  it("starts rotating as soon as the first question arrives", async () => {
    draws([0.9])
    const m = mount({ statusLabel: "Thinking" })

    await tick()
    expect(m.label()).toBe("Thinking")

    m.props.researchQuestions = ["Who is Uddhava?"]
    await nextTick()
    await tick()

    expect(m.label()).toBe("Who is Uddhava?")
  })

  it("stops rotating once the pill is gone", async () => {
    draws([0.9])
    const m = mount({ statusLabel: "Thinking", researchQuestions: ["Who is Uddhava?"] })

    await tick()
    m.unmount()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("StatusPill — animated width", () => {
  beforeEach(() => {
    let width = 0
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      width = (this.textContent ?? "").length * 7.5
      return { width, left: 0, top: 0, height: 16, right: width, bottom: 16 } as DOMRect
    }
  })

  it("re-measures when a longer label comes in", async () => {
    const m = mount({ statusLabel: "Thinking" })

    m.props.statusLabel = "Composing answer"
    await nextTick()

    const pill = m.host.querySelector<HTMLElement>(".status-pill")!
    expect(pill.style.getPropertyValue("--ticker-width")).toBe("120px")
  })

  // The width watcher cannot do this one: an immediate callback runs
  // synchronously at setup, before the probe span exists, so the first label
  // used to render at the CSS fallback and then jump.
  it("measures the very first label", async () => {
    const m = mount({ statusLabel: "Thinking" })
    await nextTick()

    const pill = m.host.querySelector<HTMLElement>(".status-pill")!
    expect(pill.style.getPropertyValue("--ticker-width")).toBe("60px")
  })
})

describe("StatusPill — with no status label", () => {
  // There is no fallback label, and a single research item never starts the
  // rotation, so the pill used to render blank for as long as it was shown.
  it("shows the one research item it was given", async () => {
    const m = mount({ researchQuestions: ["what is bhakti?"] })
    await nextTick()
    expect(m.label()).toBe("what is bhakti?")
  })

  it("shows a research source when that is all there is", async () => {
    const m = mount({ researchSources: new Map([["s1", { label: "A lecture" }]]) })
    await nextTick()
    expect(m.label()).toBe("A lecture")
  })

  it("still has nothing to show when the pool is empty", async () => {
    const m = mount({})
    await nextTick()
    expect(m.label()).toBe("")
  })
})

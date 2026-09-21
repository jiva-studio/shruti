// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive } from "vue"
import VerseRefChip from "../VerseRefChip.vue"

interface Reference {
  tokens: string[]
  label?: string
  original?: string[]
  transliteration?: string[]
  translation?: string
}

interface Mounted {
  host: HTMLElement
  chip: HTMLButtonElement
  card: () => HTMLElement | null
  unmount: () => void
}

function mount(reference: Reference): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive({ reference })
  const app = createApp({ render: () => h(VerseRefChip, { reference: state.reference }) })
  app.mount(host)
  return {
    host,
    chip: host.querySelector<HTMLButtonElement>(".vref-chip")!,
    card: () => host.querySelector<HTMLElement>(".vref-card"),
    unmount: () => app.unmount(),
  }
}

const full: Reference = {
  tokens: ["5", "18"],
  label: "BG 5.18",
  original: ["वidyā-vinaya"],
  transliteration: ["*vidyā*-vinaya"],
  translation: "The humble sages see with **equal vision**",
}

describe("VerseRefChip", () => {
  it("labels itself with the baked reference", () => {
    const m = mount(full)

    expect(m.chip.textContent).toBe("BG 5.18")
  })

  it("falls back to the raw tokens when the wire carried no label", () => {
    const m = mount({ tokens: ["5", "18"] })

    expect(m.chip.textContent).toBe("5.18")
  })

  it("only looks openable when there is a verse behind it", () => {
    const withVerse = mount(full)
    const bare = mount({ tokens: ["5", "18"], label: "BG 5.18" })

    expect(withVerse.chip.classList.contains("openable")).toBe(true)
    expect(bare.chip.classList.contains("openable")).toBe(false)
  })

  it("opens the verse on a tap and closes it on the next one", async () => {
    const m = mount(full)

    expect(m.card()).toBeNull()

    m.chip.click()
    await nextTick()
    expect(m.card()).not.toBeNull()

    m.chip.click()
    await nextTick()
    expect(m.card()).toBeNull()
  })

  it("stays shut for a reference with nothing to show", async () => {
    const m = mount({ tokens: ["5", "18"], label: "BG 5.18" })

    m.chip.click()
    await nextTick()

    expect(m.card()).toBeNull()
  })

  it("opens on a translation alone", async () => {
    const m = mount({ tokens: ["5", "18"], translation: "The humble sages" })

    m.chip.click()
    await nextTick()

    expect(m.card()!.querySelector(".vref-translation")!.textContent).toBe("The humble sages")
  })

  it("renders the verse's emphasis rather than its markdown", async () => {
    const m = mount(full)

    m.chip.click()
    await nextTick()

    expect(m.card()!.querySelector(".vref-iast")!.innerHTML).toContain("<em>vidyā</em>")
    expect(m.card()!.querySelector(".vref-translation")!.innerHTML).toContain(
      "<strong>equal vision</strong>"
    )
  })

  it("shows every line of the original", async () => {
    const m = mount({ ...full, original: ["line one", "line two"] })

    m.chip.click()
    await nextTick()

    expect([...m.card()!.querySelectorAll(".vref-original")].map((e) => e.textContent)).toEqual([
      "line one",
      "line two",
    ])
  })

  it("dismisses when the reader taps anywhere else", async () => {
    const m = mount(full)

    m.chip.click()
    await nextTick()

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await nextTick()

    expect(m.card()).toBeNull()
  })

  it("dismisses when the card itself is tapped", async () => {
    const m = mount(full)

    m.chip.click()
    await nextTick()
    m.card()!.click()
    await nextTick()

    expect(m.card()).toBeNull()
  })
})

// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, type Slots } from "vue"
import ExcerptCard from "../ExcerptCard.vue"

interface Props {
  text: string
  language?: string
  authorName?: string
  trackTitle?: string
  trackDate?: string
  reference?: string
}

function mount(props: Props, slots: Slots = {}): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  createApp({ render: () => h(ExcerptCard, { ...props }, slots) }).mount(host)
  return host
}

describe("ExcerptCard", () => {
  it("renders the excerpt html the host prepared", () => {
    const host = mount({ text: "The soul is <strong>eternal</strong>." })

    expect(host.querySelector(".highlight-text span")!.innerHTML).toBe(
      "The soul is <strong>eternal</strong>."
    )
  })

  it("puts the attribution under the quote", () => {
    const host = mount({
      text: "A line.",
      authorName: "Prabhupada",
      trackTitle: "Morning Walk",
      reference: "BG 2.20",
      trackDate: "1974-05-27",
    })

    expect(host.querySelector(".author")!.textContent).toBe("Prabhupada")
    expect(host.querySelector(".title")!.textContent).toBe("Morning Walk")
    expect(host.querySelector(".meta")!.textContent).toBe("BG 2.20 · 1974-05-27")
  })

  it("joins only the reference part it has", () => {
    const host = mount({ text: "A line.", reference: "BG 2.20" })

    expect(host.querySelector(".meta")!.textContent).toBe("BG 2.20")
  })

  it("leaves out the whole meta block when nothing is attributed", () => {
    const host = mount({ text: "A line." })

    expect(host.querySelector(".meta-block")).toBeNull()
  })

  it("ignores a title that is only whitespace", () => {
    const host = mount({ text: "A line.", trackTitle: "   " })

    expect(host.querySelector(".title")).toBeNull()
  })

  it("renders nothing but the player for an excerpt with no text or meta", () => {
    const host = mount({ text: "" }, { player: () => [h("div", { class: "player" })] })

    expect(host.querySelector(".excerpt-body")).toBeNull()
    expect(host.querySelector(".player")).not.toBeNull()
  })

  it("keeps the attribution for a card whose text has not rendered yet", () => {
    const host = mount({ text: "", authorName: "Prabhupada" })

    expect(host.querySelector(".highlight-text")).toBeNull()
    expect(host.querySelector(".author")!.textContent).toBe("Prabhupada")
  })
})
